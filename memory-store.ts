import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type {
    IMemoryStore,
    MemoryEntry,
    MemoryId,
    MemoryKind,
    MemoryStoreEvent,
    ProjectId,
    ProjectMemory,
    SessionId,
    SessionSummary,
} from './types.ts';
import { ProjectMemorySchema, memoryId, projectId, sessionId } from '../types.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1 as const;
const STAGEWISE_DIR = '.stagewise';
const MEMORY_FILENAME = 'memory.json';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function deriveProjectId(projectRoot: string): ProjectId {
    return projectId(
        createHash('sha256').update(projectRoot).digest('hex').slice(0, 16),
    );
}

function nowIso(): string {
    return new Date().toISOString();
}

function newMemoryId(): MemoryId {
    return memoryId(`mem_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
}

function newSessionId(): SessionId {
    return sessionId(`sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
}

// ─── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore implements IMemoryStore {
    readonly projectId: ProjectId;

    private readonly storePath: string;
    private readonly projectRoot: string;
    private readonly projectName: string;

    private data: ProjectMemory | null = null;
    private readonly listeners: Set<(event: MemoryStoreEvent) => void> = new Set();

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
        this.projectName = projectRoot.split('/').filter(Boolean).at(-1) ?? 'unknown';
        this.projectId = deriveProjectId(projectRoot);
        this.storePath = join(projectRoot, STAGEWISE_DIR, MEMORY_FILENAME);
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    async load(): Promise<void> {
        try {
            const raw = await readFile(this.storePath, 'utf-8');
            const parsed = ProjectMemorySchema.parse(JSON.parse(raw));
            this.data = parsed;
        } catch (err) {
            if (isNodeError(err) && err.code === 'ENOENT') {
                // First run — initialise empty store
                this.data = this.createEmptyStore();
                await this.persist();
            } else {
                throw new Error(
                    `[agent-memory] Failed to load memory store at ${this.storePath}: ${String(err)}`,
                );
            }
        }

        this.emit({ type: 'store:loaded', projectId: this.projectId });
    }

    async save(): Promise<void> {
        this.assertLoaded();
        await this.persist();
    }

    // ─── Entries ─────────────────────────────────────────────────────────────

    async addEntry(
        entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'useCount'>,
    ): Promise<MemoryEntry> {
        this.assertLoaded();

        const now = nowIso();
        const newEntry: MemoryEntry = {
            ...entry,
            id: newMemoryId(),
            createdAt: now,
            updatedAt: now,
            useCount: 0,
        };

        this.data!.entries.push(newEntry);
        this.data!.lastUpdatedAt = now;

        await this.persist();
        this.emit({ type: 'entry:added', entry: newEntry });

        return newEntry;
    }

    async updateEntry(
        id: MemoryId,
        patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>,
    ): Promise<MemoryEntry> {
        this.assertLoaded();

        const idx = this.findEntryIndex(id);
        const existing = this.data!.entries[idx]!;
        const updated: MemoryEntry = {
            ...existing,
            ...patch,
            id: existing.id,
            createdAt: existing.createdAt,
            updatedAt: nowIso(),
        };

        this.data!.entries[idx] = updated;
        this.data!.lastUpdatedAt = updated.updatedAt;

        await this.persist();
        this.emit({ type: 'entry:updated', entry: updated });

        return updated;
    }

    async deleteEntry(id: MemoryId): Promise<void> {
        this.assertLoaded();

        const idx = this.findEntryIndex(id);
        this.data!.entries.splice(idx, 1);
        this.data!.lastUpdatedAt = nowIso();

        await this.persist();
        this.emit({ type: 'entry:deleted', id });
    }

    async setEntryStatus(
        id: MemoryId,
        status: MemoryEntry['status'],
    ): Promise<MemoryEntry> {
        const updated = await this.updateEntry(id, { status });
        this.emit({ type: 'entry:status-changed', id, status });
        return updated;
    }

    listEntries(filter?: {
        kinds?: ReadonlyArray<MemoryKind>;
        status?: MemoryEntry['status'];
        tags?: ReadonlyArray<string>;
    }): MemoryEntry[] {
        this.assertLoaded();

        let entries = [...this.data!.entries];

        if (filter?.kinds !== undefined && filter.kinds.length > 0) {
            entries = entries.filter((e) => filter.kinds!.includes(e.kind));
        }

        if (filter?.status !== undefined) {
            entries = entries.filter((e) => e.status === filter.status);
        }

        if (filter?.tags !== undefined && filter.tags.length > 0) {
            entries = entries.filter((e) =>
                filter.tags!.some((tag) => e.tags.includes(tag)),
            );
        }

        return entries;
    }

    getEntry(id: MemoryId): MemoryEntry | undefined {
        this.assertLoaded();
        return this.data!.entries.find((e) => e.id === id);
    }

    // ─── Sessions ────────────────────────────────────────────────────────────

    async saveSession(
        summary: Omit<SessionSummary, 'sessionId'>,
    ): Promise<SessionSummary> {
        this.assertLoaded();

        const session: SessionSummary = {
            ...summary,
            sessionId: newSessionId(),
        };

        this.data!.sessions.unshift(session); // newest first
        this.data!.lastUpdatedAt = nowIso();

        await this.persist();
        this.emit({ type: 'session:saved', session });

        return session;
    }

    listSessions(limit = 20): SessionSummary[] {
        this.assertLoaded();
        return this.data!.sessions.slice(0, limit);
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    on(listener: (event: MemoryStoreEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    private assertLoaded(): asserts this is { data: ProjectMemory } {
        if (this.data === null) {
            throw new Error(
                '[agent-memory] MemoryStore must be loaded before use. Call `await store.load()` first.',
            );
        }
    }

    private findEntryIndex(id: MemoryId): number {
        const idx = this.data!.entries.findIndex((e) => e.id === id);
        if (idx === -1) {
            throw new Error(`[agent-memory] Entry not found: ${id}`);
        }
        return idx;
    }

    private createEmptyStore(): ProjectMemory {
        return {
            projectId: this.projectId,
            projectName: this.projectName,
            projectRoot: this.projectRoot,
            schemaVersion: SCHEMA_VERSION,
            entries: [],
            sessions: [],
            lastUpdatedAt: nowIso(),
        };
    }

    private async persist(): Promise<void> {
        this.assertLoaded();
        await mkdir(dirname(this.storePath), { recursive: true });
        await writeFile(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
        this.emit({ type: 'store:saved', projectId: this.projectId });
    }

    private emit(event: MemoryStoreEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and immediately load a MemoryStore for the given project root.
 *
 * @example
 * ```ts
 * const store = await createMemoryStore('/Users/me/projects/my-app');
 * const entries = store.listEntries({ status: 'approved' });
 * ```
 */
export async function createMemoryStore(projectRoot: string): Promise<MemoryStore> {
    const store = new MemoryStore(projectRoot);
    await store.load();
    return store;
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err;
}

// Re-export the Zod parse helper for external schema validation
export { z };
export type { ProjectMemory };