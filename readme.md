# Stagewise Persistent Agent Memory: Proof of Work Proposal

**Author:** Anurag Sharma ([github.com/Anurag13075](https://github.com/Anurag13075))  
**Target:** Internship Application @ Stagewise  
**Package:** `@stagewise/agent-memory`

---

## 1. Executive Summary

One of the largest friction points in agentic coding today is **"AI Amnesia."** When a developer corrects an agent (e.g., *"Don't use relative imports for shared UI components"*), the agent learns it for that specific session. However, as soon as a new session starts, the context is lost, and the developer is forced to repeat the same corrections.

To solve this, I have built `@stagewise/agent-memory`—a robust, zero-dependency, drop-in TypeScript package designed specifically for the Stagewise monorepo. It acts as a **Persistent Project Brain**, allowing the agent to dynamically learn project conventions, user preferences, and past corrections, persisting them directly to the user's local workspace (`.stagewise/memory.json`).

## 2. Why Stagewise Needs This

- **Eliminates Developer Fatigue:** Users no longer have to endlessly remind the agent of project-specific quirks.
- **Team-Wide Knowledge Sharing:** Because memory is saved to `.stagewise/memory.json`, it can be committed to Git. If a senior engineer corrects the agent's architectural pattern once, junior developers on the team benefit immediately.
- **Offline & Blazing Fast:** The `MemoryExtractor` utilizes a strict, rule-based RegExp engine to extract signal from chat transcripts. It does not require additional LLM API calls, ensuring extraction is instantaneous and doesn't drain the user's API token budget.

## 3. Seamless Architectural Fit

I deeply analyzed the `stagewise-io/stagewise` codebase to ensure this package is a perfect architectural drop-in, respecting all monorepo rules:

1. **Strict Monorepo Guidelines:** The package is designed to live in `packages/agent-memory`, utilizing `workspace:*` dependencies, strict ES Modules (`type: "module"`), and extending `@stagewise/typescript-config`.
2. **Event-Driven Reactivity for Karton:** The `MemoryStore` implements a native event emitter (`store.on('entry:added', ...)`). This allows the Stagewise backend to effortlessly pipe memory state updates over the `@stagewise/karton` RPC bridge, making the React UI instantly reactive to new memories.
3. **Decoupled Design:** The logic is strictly separated into three domains to match Stagewise's service-oriented architecture:
   - `MemoryStore`: Handles local I/O and state management via native Node `fs/promises`.
   - `ContextInjector`: Fast TF-IDF inspired retrieval that formats context blocks for the agent's system prompt.
   - `MemoryExtractor`: Post-session transcript analysis to identify repeatable skills, preferences, and corrections.

## 4. Effortless Integration

Wiring this into the existing Electron backend (`apps/browser/src/backend/main.ts`) requires minimal boilerplate.

**A. Initialization alongside existing services:**
```typescript
import { createMemoryStore, createInjector, createExtractor } from '@stagewise/agent-memory';

// In main.ts:
const memoryStore = await createMemoryStore(workspaceRootPath);
const contextInjector = createInjector(memoryStore);
const memoryExtractor = createExtractor(memoryStore);
```

**B. UI Reactivity (via Karton):**
```typescript
memoryStore.on((event) => {
  uiKarton.setState((draft) => {
    // UI updates instantly when the agent learns a new rule
    draft.memoryEvents.push(event); 
  });
});
```

**C. Pre-Session Context Injection (AgentManagerService):**
```typescript
const injectedContext = await contextInjector.retrieve({
  query: userPrompt,
  kinds: ['preference', 'correction', 'convention']
});
const finalSystemPrompt = injectedContext.systemPromptBlock + '\n\n' + baseSystemPrompt;
```

**D. Post-Session Extraction:**
```typescript
// At the end of a session:
await memoryExtractor.processSession({
  turns: session.turns,
  filesChanged: session.modifiedFiles,
  startedAt: session.startTime,
  endedAt: session.endTime,
  projectName: "Active Workspace"
}, projectId);
```

## 5. Internship Roadmap

If brought on as an intern, my immediate goals to productionize and expand this feature would be:

1. **Build the UI Components:** Utilize `@stagewise/stage-ui` (React, Tailwind CSS, Base UI) to build a "Memory Manager" panel where developers can view, edit, and manually approve/reject pending agent memories.
2. **LLM-Powered Extraction Opt-In:** Upgrade the offline rule-based extractor to optionally use a local/cheap LLM (e.g., via Ollama or an open router) to do deeper semantic memory extraction in the background.
3. **Vector Embeddings Integration:** Swap the TF-IDF scoring in `ContextInjector` with a lightweight, local vector embedding database to make memory retrieval semantically aware.

---
*I built this to demonstrate my ability to quickly understand complex codebases, adhere to strict architectural patterns, and ship production-ready, highly relevant features. I would love the opportunity to contribute this—and much more—to Stagewise.*
