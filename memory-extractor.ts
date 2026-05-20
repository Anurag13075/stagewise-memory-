import type {
    IMemoryStore,
    MemoryEntry,
    MemoryKind,
    SessionSummary,
} from './types.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Represents a single agent turn in a session transcript.
 */
export interface AgentTurn {
    role: 'user' | 'agent';
    content: string;
    /** Optional timestamp for ordering */
    timestamp?: string;
}

/**
 * Input provided to the extractor at the end of an agent session.
 */
export interface SessionTranscript {
    /** Ordered list of turns in the session */
    turns: AgentTurn[];

    /** Files touched during the session (relative paths) */
    filesChanged: string[];

    /** ISO-8601 session start time */
    startedAt: string;

    /** ISO-8601 session end time */
    endedAt: string;

    /** Human-readable project name for context */
    projectName: string;
}

/**
 * A candidate memory entry before it is written to the store.
 */
export interface ExtractionCandidate {
    kind: MemoryKind;
    content: string;
    tags: string[];
    confidence: number;
    payload?: Record<string, unknown>;
}

/**
 * Result of a full extraction run.
 */
export interface ExtractionResult {
    candidates: ExtractionCandidate[];
    sessionSummary: Omit<SessionSummary, 'sessionId'>;
}

// ─── Patterns ──────────────────────────────────────────────────────────────────

/**
 * Rule-based patterns used to detect extractable signal in agent turns.
 *
 * These are intentionally simple — a production implementation would call
 * an LLM here, but we want this package to be fully offline-capable and
 * not require an extra API key. The injector compensates by providing rich
 * context so the agent can self-refine these over time.
 */

interface ExtractionRule {
    id: string;
    kind: MemoryKind;
    /** Test the turn content against this predicate */
    test(turn: AgentTurn, allTurns: AgentTurn[]): boolean;
    /** Extract a candidate from the matching turn */
    extract(turn: AgentTurn, allTurns: AgentTurn[]): ExtractionCandidate | null;
}

const CORRECTION_PHRASES = [
    "that's wrong",
    "that is wrong",
    "incorrect",
    'no, actually',
    "don't do that",
    "don't use",
    'you should not',
    'please undo',
    'revert that',
    'not like that',
    "that's not right",
    'stop using',
    'avoid using',
] as const;

const PREFERENCE_PHRASES = [
    'always use',
    'i prefer',
    'we always',
    'please always',
    'make sure to always',
    'in this project we',
    'our convention is',
    'our style is',
    'we follow',
] as const;

const SKILL_PHRASES = [
    'when adding a new',
    'whenever you need to',
    'the pattern for',
    'the way we',
    'to create a new',
    'to add a new',
] as const;

function containsAny(text: string, phrases: ReadonlyArray<string>): boolean {
    const lower = text.toLowerCase();
    return phrases.some((p) => lower.includes(p));
}

function extractTags(content: string): string[] {
    const tags: string[] = [];
    const lower = content.toLowerCase();

    const techKeywords = [
        'react', 'typescript', 'tailwind', 'css', 'api', 'route', 'component',
        'hook', 'store', 'test', 'type', 'interface', 'function', 'class',
        'import', 'export', 'style', 'naming', 'format', 'lint', 'build',
        'database', 'model', 'schema', 'auth', 'server', 'client',
    ] as const;

    for (const keyword of techKeywords) {
        if (lower.includes(keyword)) {
            tags.push(keyword);
        }
    }

    return [...new Set(tags)];
}

const EXTRACTION_RULES: ExtractionRule[] = [
    // ── Corrections ────────────────────────────────────────────────────────────
    {
        id: 'correction:user-explicit',
        kind: 'correction',
        test: (turn) =>
            turn.role === 'user' && containsAny(turn.content, CORRECTION_PHRASES),
        extract: (turn) => ({
            kind: 'correction',
            content: `User correction: ${turn.content.slice(0, 300)}`,
            tags: extractTags(turn.content),
            confidence: 0.85,
        }),
    },

    // ── Preferences ────────────────────────────────────────────────────────────
    {
        id: 'preference:user-stated',
        kind: 'preference',
        test: (turn) =>
            turn.role === 'user' && containsAny(turn.content, PREFERENCE_PHRASES),
        extract: (turn) => ({
            kind: 'preference',
            content: turn.content.slice(0, 400),
            tags: extractTags(turn.content),
            confidence: 0.80,
        }),
    },

    // ── Skills ─────────────────────────────────────────────────────────────────
    {
        id: 'skill:user-pattern',
        kind: 'skill',
        test: (turn) =>
            turn.role === 'user' && containsAny(turn.content, SKILL_PHRASES),
        extract: (turn) => ({
            kind: 'skill',
            content: `Reusable pattern: ${turn.content.slice(0, 400)}`,
            tags: extractTags(turn.content),
            confidence: 0.70,
            payload: {
                trigger: turn.content.split('.')[0] ?? turn.content.slice(0, 80),
                instruction: turn.content.slice(0, 400),
            },
        }),
    },
];

// ─── Extractor ─────────────────────────────────────────────────────────────────

export class MemoryExtractor {
    private readonly store: IMemoryStore;

    constructor(store: IMemoryStore) {
        this.store = store;
    }

    /**
     * Process a completed session transcript, extract memory candidates,
     * write them to the store as `pending`, and save a session summary.
     *
     * Returns the extraction result so callers can inspect what was found.
     */
    async processSession(
        transcript: SessionTranscript,
        projectId: string,
    ): Promise<ExtractionResult> {
        const candidates = this.extractCandidates(transcript);
        const sessionSummary = this.buildSessionSummary(transcript, projectId);

        // Persist each candidate as `pending` — the user reviews in the UI
        for (const candidate of candidates) {
            await this.store.addEntry({
                kind: candidate.kind,
                content: candidate.content,
                tags: candidate.tags,
                confidence: candidate.confidence,
                payload: candidate.payload,
                status: 'pending',
                sourceSessionId: undefined,
            });
        }

        // Persist the session summary
        await this.store.saveSession(sessionSummary);

        return { candidates, sessionSummary };
    }

    /**
     * Perform extraction without writing to the store.
     * Useful for previewing what would be extracted.
     */
    dryRun(transcript: SessionTranscript): ExtractionCandidate[] {
        return this.extractCandidates(transcript);
    }

    // ─── Private ───────────────────────────────────────────────────────────────

    private extractCandidates(
        transcript: SessionTranscript,
    ): ExtractionCandidate[] {
        const candidates: ExtractionCandidate[] = [];
        const seen = new Set<string>();

        for (const turn of transcript.turns) {
            for (const rule of EXTRACTION_RULES) {
                if (!rule.test(turn, transcript.turns)) {
                    continue;
                }

                const candidate = rule.extract(turn, transcript.turns);
                if (candidate === null) {
                    continue;
                }

                // Deduplicate by normalised content fingerprint
                const fingerprint = candidate.content.toLowerCase().slice(0, 60);
                if (seen.has(fingerprint)) {
                    continue;
                }

                seen.add(fingerprint);
                candidates.push(candidate);
            }
        }

        // Sort by descending confidence
        return candidates.sort((a, b) => b.confidence - a.confidence);
    }

    private buildSessionSummary(
        transcript: SessionTranscript,
        projectId: string,
    ): Omit<SessionSummary, 'sessionId'> {
        const userTurns = transcript.turns
            .filter((t) => t.role === 'user')
            .map((t) => t.content);

        const agentTurns = transcript.turns
            .filter((t) => t.role === 'agent')
            .map((t) => t.content);

        // Build a compact summary from the first and last user messages
        const firstUserMsg = userTurns.at(0) ?? '';
        const lastUserMsg = userTurns.at(-1) ?? '';
        const lastAgentMsg = agentTurns.at(-1) ?? '';

        const summaryParts: string[] = [
            `Task started with: "${firstUserMsg.slice(0, 120)}"`,
        ];

        if (lastUserMsg !== firstUserMsg) {
            summaryParts.push(`Last user message: "${lastUserMsg.slice(0, 100)}"`);
        }

        if (lastAgentMsg) {
            summaryParts.push(`Agent concluded: "${lastAgentMsg.slice(0, 100)}"`);
        }

        // Detect corrections from transcript
        const corrections = transcript.turns
            .filter(
                (t) => t.role === 'user' && containsAny(t.content, CORRECTION_PHRASES),
            )
            .map((t) => t.content.slice(0, 120));

        return {
            projectId: projectId as ReturnType<typeof import('../types.js').projectId>,
            summary: summaryParts.join(' | '),
            filesChanged: transcript.filesChanged.slice(0, 50),
            decisions: [],
            corrections: corrections.slice(0, 20),
            startedAt: transcript.startedAt,
            endedAt: transcript.endedAt,
        };
    }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createExtractor(store: IMemoryStore): MemoryExtractor {
    return new MemoryExtractor(store);
}