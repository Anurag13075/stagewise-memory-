import type {
    IMemoryStore,
    InjectedContext,
    MemoryEntry,
    RetrievalQuery,
    RetrievedEntry,
} from './types.js';

// ─── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a single entry against a query using TF-IDF-inspired term matching.
 *
 * This is intentionally offline and dependency-free. A richer embedding-based
 * approach can be swapped in by replacing this function.
 */
function scoreEntry(entry: MemoryEntry, queryTerms: string[]): number {
    if (queryTerms.length === 0) {
        return 0.1; // Baseline — return anything when no query terms
    }

    const corpus = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
    const corpusTerms = corpus.split(/\s+/);
    const totalTerms = corpusTerms.length;

    let termMatchScore = 0;
    for (const term of queryTerms) {
        const count = corpusTerms.filter((t) => t.includes(term)).length;
        if (count > 0) {
            // TF component (normalised)
            termMatchScore += count / totalTerms;
        }
    }

    // Normalise to [0, 1]
    const tfScore = Math.min(termMatchScore / queryTerms.length, 1.0);

    // Boost by confidence and use count (capped)
    const useBoost = Math.min(entry.useCount / 20, 0.2);
    const confidenceBoost = entry.confidence * 0.3;

    return Math.min(tfScore + useBoost + confidenceBoost, 1.0);
}

// ─── ContextInjector ───────────────────────────────────────────────────────────

export interface InjectorOptions {
    /**
     * Maximum number of memory entries to inject per request.
     * Defaults to 8.
     */
    topK?: number;

    /**
     * Minimum relevance score for an entry to be included.
     * Defaults to 0.05.
     */
    minScore?: number;

    /**
     * Whether to include session summaries in the injected context.
     * Defaults to true.
     */
    includeSessions?: boolean;

    /**
     * Maximum number of recent sessions to include.
     * Defaults to 3.
     */
    maxSessions?: number;
}

export class ContextInjector {
    private readonly store: IMemoryStore;
    private readonly options: Required<InjectorOptions>;

    constructor(store: IMemoryStore, options: InjectorOptions = {}) {
        this.store = store;
        this.options = {
            topK: options.topK ?? 8,
            minScore: options.minScore ?? 0.05,
            includeSessions: options.includeSessions ?? true,
            maxSessions: options.maxSessions ?? 3,
        };
    }

    /**
     * Retrieve and format memory context for the given query.
     *
     * The returned `systemPromptBlock` is ready to prepend to the agent's
     * system prompt. Bump `useCount` for retrieved entries so that frequently
     * referenced entries surface higher in future retrievals.
     */
    async retrieve(query: RetrievalQuery): Promise<InjectedContext> {
        const approvedEntries = this.store.listEntries({
            kinds: query.kinds,
            status: 'approved',
            tags: query.tags,
        });

        const queryTerms = query.query
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length > 2);

        const topK = query.topK ?? this.options.topK;

        // Score and rank
        const scored: RetrievedEntry[] = approvedEntries
            .map((entry) => ({
                entry,
                score: scoreEntry(entry, queryTerms),
            }))
            .filter((r) => r.score >= this.options.minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        // Bump use counts asynchronously — do not await so retrieval stays fast
        void this.bumpUseCounts(scored.map((r) => r.entry.id));

        // Build sessions block
        const sessions = this.options.includeSessions
            ? this.store.listSessions(this.options.maxSessions)
            : [];

        const systemPromptBlock = this.formatSystemPromptBlock(scored, sessions);

        return { systemPromptBlock, entries: scored };
    }

    /**
     * Format a context block suitable for injection into a system prompt.
     */
    private formatSystemPromptBlock(
        entries: RetrievedEntry[],
        sessions: ReturnType<IMemoryStore['listSessions']>,
    ): string {
        if (entries.length === 0 && sessions.length === 0) {
            return '';
        }

        const lines: string[] = [
            '<!-- stagewise:memory-context -->',
            'The following is persistent memory about this project. Follow these conventions carefully.',
            '',
        ];

        // ── Group by kind ────────────────────────────────────────────────────────

        const grouped = new Map<string, RetrievedEntry[]>();
        for (const entry of entries) {
            const key = entry.entry.kind;
            if (!grouped.has(key)) {
                grouped.set(key, []);
            }
            grouped.get(key)!.push(entry);
        }

        const kindLabels: Record<string, string> = {
            convention: '### Code Conventions',
            correction: '### Past Corrections (do not repeat these mistakes)',
            preference: '### Developer Preferences',
            fact: '### Project Facts',
            skill: '### Reusable Skills',
            session: '### Previous Session Notes',
        };

        for (const [kind, kindEntries] of grouped) {
            const label = kindLabels[kind] ?? `### ${kind}`;
            lines.push(label);
            for (const { entry } of kindEntries) {
                lines.push(`- ${entry.content}`);
            }
            lines.push('');
        }

        // ── Recent sessions ──────────────────────────────────────────────────────

        if (sessions.length > 0) {
            lines.push('### Recent Session Summaries');
            for (const session of sessions) {
                const date = new Date(session.endedAt).toLocaleDateString();
                lines.push(`**${date}:** ${session.summary}`);
                if (session.filesChanged.length > 0) {
                    lines.push(`  Files touched: ${session.filesChanged.join(', ')}`);
                }
                if (session.corrections.length > 0) {
                    lines.push(`  Corrections: ${session.corrections.join('; ')}`);
                }
            }
            lines.push('');
        }

        lines.push('<!-- /stagewise:memory-context -->');

        return lines.join('\n');
    }

    private async bumpUseCounts(ids: ReturnType<IMemoryStore['getEntry']>['id'][]): Promise<void> {
        for (const id of ids) {
            const entry = this.store.getEntry(id);
            if (entry === undefined) {
                continue;
            }
            // Fire-and-forget — store handles queuing internally
            this.store
                .updateEntry(id, { useCount: entry.useCount + 1 })
                .catch(() => {
                    // Non-fatal
                });
        }
    }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createInjector(
    store: IMemoryStore,
    options?: InjectorOptions,
): ContextInjector {
    return new ContextInjector(store, options);
}