import { z } from 'zod';

// ─── Branded primitive types ───────────────────────────────────────────────────

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type MemoryId = Brand<string, 'MemoryId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type SessionId = Brand<string, 'SessionId'>;

export const memoryId = (id: string): MemoryId => id as MemoryId;
export const projectId = (id: string): ProjectId => id as ProjectId;
export const sessionId = (id: string): SessionId => id as SessionId;

// ─── Memory entry kinds ────────────────────────────────────────────────────────

/**
 * Convention: a coding pattern the agent learned about this codebase.
 * e.g. "always use `cn()` for className merging"
 */
export const MemoryKindSchema = z.enum([
    'convention',   // Code style / naming / architecture patterns
    'correction',   // Something the user explicitly corrected
    'preference',   // User-stated preference
    'fact',         // Stable codebase fact (tech stack, key files, etc.)
    'session',      // Condensed summary of a completed session
    'skill',        // A reusable instruction the agent can follow
]);

export type MemoryKind = z.infer<typeof MemoryKindSchema>;

// ─── Memory entry ─────────────────────────────────────────────────────────────

export const MemoryEntrySchema = z.object({
    id: z.string().transform((s) => s as MemoryId),

    /** Discriminates what this memory represents */
    kind: MemoryKindSchema,

    /** Short natural-language summary for context injection */
    content: z.string().min(1).max(2000),

    /**
     * Optional structured payload (e.g. a skill has `trigger` + `instruction`).
     * Kept as unknown so consumers can narrow with their own schema.
     */
    payload: z.record(z.string(), z.unknown()).optional(),

    /** ISO-8601 timestamp when this entry was created */
    createdAt: z.string().datetime(),

    /** ISO-8601 timestamp of the most recent update */
    updatedAt: z.string().datetime(),

    /**
     * Number of times this entry has been injected into agent context.
     * Used for relevance scoring.
     */
    useCount: z.number().int().nonneg(),

    /**
     * Freeform tags for filtering / retrieval.
     * e.g. ["react", "styling", "tailwind"]
     */
    tags: z.array(z.string()),

    /** Whether the user has approved this entry (default: pending for auto-extracted) */
    status: z.enum(['pending', 'approved', 'rejected']),

    /**
     * Confidence score [0, 1] set by the extractor.
     * User-created entries default to 1.0.
     */
    confidence: z.number().min(0).max(1),

    /** Session that produced this entry, if any */
    sourceSessionId: z.string().transform((s) => s as SessionId).optional(),
});

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ─── Skill payload ────────────────────────────────────────────────────────────

export const SkillPayloadSchema = z.object({
    /**
     * Natural language description of when to apply this skill.
     * e.g. "When the user asks to add a new API route"
     */
    trigger: z.string().min(1),

    /**
     * Step-by-step instruction for the agent to follow.
     */
    instruction: z.string().min(1),

    /**
     * Optional example showing input → expected output.
     */
    example: z
        .object({
            input: z.string(),
            output: z.string(),
        })
        .optional(),
});

export type SkillPayload = z.infer<typeof SkillPayloadSchema>;

// ─── Session summary ──────────────────────────────────────────────────────────

export const SessionSummarySchema = z.object({
    sessionId: z.string().transform((s) => s as SessionId),
    projectId: z.string().transform((s) => s as ProjectId),

    /** Agent-written summary of what was accomplished */
    summary: z.string().min(1),

    /**
     * Compact list of files touched (paths relative to project root).
     * Kept small — this is injected into future context windows.
     */
    filesChanged: z.array(z.string()).max(50),

    /** Explicit decisions the agent or user made during the session */
    decisions: z.array(z.string()).max(20),

    /** Things the user explicitly corrected or rejected */
    corrections: z.array(z.string()).max(20),

    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ─── Project memory store ─────────────────────────────────────────────────────

export const ProjectMemorySchema = z.object({
    /**
     * Stable identifier derived from the project root path.
     * We hash it so it is safe to use as a filename.
     */
    projectId: z.string().transform((s) => s as ProjectId),

    /** Human-readable project name (directory basename) */
    projectName: z.string(),

    /** Absolute path to the project root */
    projectRoot: z.string(),

    schemaVersion: z.literal(1),

    entries: z.array(MemoryEntrySchema),
    sessions: z.array(SessionSummarySchema),

    /** ISO-8601 — last time anything in this store changed */
    lastUpdatedAt: z.string().datetime(),
});

export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

// ─── Store events (for reactive UI) ──────────────────────────────────────────

export type MemoryStoreEvent =
    | { type: 'entry:added'; entry: MemoryEntry }
    | { type: 'entry:updated'; entry: MemoryEntry }
    | { type: 'entry:deleted'; id: MemoryId }
    | { type: 'entry:status-changed'; id: MemoryId; status: MemoryEntry['status'] }
    | { type: 'session:saved'; session: SessionSummary }
    | { type: 'store:loaded'; projectId: ProjectId }
    | { type: 'store:saved'; projectId: ProjectId };

// ─── Retrieval ────────────────────────────────────────────────────────────────

export interface RetrievalQuery {
    /** Free-text query to match against entry content */
    query: string;

    /** Limit to these kinds */
    kinds?: ReadonlyArray<MemoryKind>;

    /** Limit to these tags */
    tags?: ReadonlyArray<string>;

    /** Only return approved entries */
    approvedOnly?: boolean;

    /** Maximum number of entries to return (default: 8) */
    topK?: number;
}

export interface RetrievedEntry {
    entry: MemoryEntry;
    /** Relevance score [0, 1] — higher is more relevant */
    score: number;
}

// ─── Context injection ────────────────────────────────────────────────────────

export interface InjectedContext {
    /** Pre-formatted text block ready to prepend to agent system prompt */
    systemPromptBlock: string;

    /** The entries that were injected (for telemetry / debugging) */
    entries: RetrievedEntry[];
}

// ─── Public API shape ─────────────────────────────────────────────────────────

export interface IMemoryStore {
    readonly projectId: ProjectId;

    /** Load or initialise the store from disk */
    load(): Promise<void>;

    /** Persist the current state to disk */
    save(): Promise<void>;

    /** Add a new entry, returning its id */
    addEntry(
        entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'useCount'>,
    ): Promise<MemoryEntry>;

    /** Update an existing entry by id */
    updateEntry(
        id: MemoryId,
        patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>,
    ): Promise<MemoryEntry>;

    /** Delete an entry by id */
    deleteEntry(id: MemoryId): Promise<void>;

    /** Change only the status of an entry */
    setEntryStatus(
        id: MemoryId,
        status: MemoryEntry['status'],
    ): Promise<MemoryEntry>;

    /** Retrieve a copy of all entries */
    listEntries(filter?: {
        kinds?: ReadonlyArray<MemoryKind>;
        status?: MemoryEntry['status'];
        tags?: ReadonlyArray<string>;
    }): MemoryEntry[];

    /** Retrieve a single entry by id */
    getEntry(id: MemoryId): MemoryEntry | undefined;

    /** Record a completed session */
    saveSession(summary: Omit<SessionSummary, 'sessionId'>): Promise<SessionSummary>;

    /** Retrieve past sessions (newest first) */
    listSessions(limit?: number): SessionSummary[];

    /** Subscribe to store events */
    on(listener: (event: MemoryStoreEvent) => void): () => void;
}