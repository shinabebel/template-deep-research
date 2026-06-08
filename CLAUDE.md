# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A human-in-the-loop deep research assistant built on [Mastra](https://mastra.ai). It iteratively researches a topic via web search, pauses for user approval, and generates a comprehensive markdown report. Everything lives under `src/mastra/` and is wired together into a single `Mastra` instance in `src/mastra/index.ts`.

## Commands

```bash
npm run dev      # mastra dev — starts the local Mastra dev server / Studio playground
                 # (use it to trigger workflows and answer suspend/resume prompts)
npm run build    # mastra build — bundles to .mastra/output
npm run start    # mastra start — runs the built output

bun run lint     # biome check — lint + format check (no writes)
bun run format   # biome check --write — apply safe fixes + formatting
                 # add --unsafe for fixable rules biome marks "unsafe" (e.g. useTemplate, useOptionalChain)
npx tsc --noEmit # typecheck (tsconfig has noEmit; Biome does not type-check)
```

- **Linting/formatting is Biome** (`biome.json`, default tabs). **No test framework is configured** — `npm test` is a placeholder that exits 1; do not assume a test runner exists.
- Requires Node `>=22.13.0`. The project is ESM (`"type": "module"`) and uses `moduleResolution: bundler`.

## Environment

Copy `.env.example` to `.env`. Four things matter:

- `MODEL` — the LLM in `provider/model-name` format (Mastra's model router, e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4-5-20250929`). Set the matching provider API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).
- `MODEL_BASE_URL` — only for local / OpenAI-compatible endpoints (see below). Leave empty for hosted providers.
- `WEB_SEARCH_PROVIDER` — which backend `webSearchTool` uses: `exa` (default) or `ollama`. See below.
- `EXA_API_KEY` / `OLLAMA_API_KEY` — the key for the selected `WEB_SEARCH_PROVIDER`; web search returns an error result (not a crash) if the matching key is missing.

All five agents import a single shared model config from [src/mastra/model.ts](src/mastra/model.ts), so `MODEL` reconfigures the entire app at once — do not re-add per-agent `model:` strings.

### Switching to a local model (Ollama)

The model-router *string* alone can't reach a local endpoint — Mastra needs the OpenAI-compatible base URL too. `model.ts` handles this: when `MODEL_BASE_URL` is set it emits a `{ id, url, apiKey }` object instead of a plain string. Configure `.env`:

```
MODEL=ollama/<tag-from-`ollama list`>     # e.g. ollama/gemma4:e4b-16k
MODEL_BASE_URL=http://localhost:11434/v1  # MUST end in /v1, NOT /api/chat
```

Requires `ollama serve` running and the model pulled. **Caveat:** the whole research flow depends on reliable tool-calling and Zod `structuredOutput`; small local models (especially Gemma) often fail at these. If tools never fire or JSON parsing errors, it's the model's capability, not the config — prefer a tool-use-capable local model (e.g. `qwen2.5`, `llama3.1`).

### Switching the web search backend (Exa vs Ollama)

[webSearchTool.ts](src/mastra/tools/webSearchTool.ts) supports two backends, selected by `WEB_SEARCH_PROVIDER`:

- `exa` (default) — Exa search via `EXA_API_KEY`.
- `ollama` — Ollama's **hosted** web search API (`POST https://ollama.com/api/web_search`, Bearer `OLLAMA_API_KEY`), called with native `fetch` (no extra dependency).

Both backends normalize to a common `{ title, url, text }` shape, are capped at `NUM_RESULTS` (2), and feed the *same* `webSummarizationAgent` loop. To add a backend, write another `search*()` that returns `RawResult[]` and branch on `provider` — leave the summarization loop untouched.

> `OLLAMA_API_KEY` (hosted web search at ollama.com) is unrelated to the local-model setup above (`MODEL_BASE_URL` → `ollama serve`). They can be used together.

## Architecture

### Two composed workflows (the orchestration backbone)

`generateReportWorkflow` is the top-level entry point. It wraps `researchWorkflow` in a **`.dowhile` loop** that re-runs the *entire* research workflow (re-prompting the user each time) until `approved === true`, then runs `processResearchResultStep` to generate the report. See [generateReportWorkflow.ts](src/mastra/workflows/generateReportWorkflow.ts).

`researchWorkflow` is three steps chained with `.then()` — see [researchWorkflow.ts](src/mastra/workflows/researchWorkflow.ts):
1. `getUserQueryStep` — **suspends** to ask the user what to research.
2. `researchStep` — calls `researchAgent` with a `structuredOutput` schema and `maxSteps: 15`.
3. `approvalStep` — **suspends** to ask "Is this research sufficient? [y/n]".

**Human-in-the-loop is implemented via Mastra's suspend/resume.** Steps that need user input declare `suspendSchema` + `resumeSchema`, call `await suspend(...)`, and short-circuit on `resumeData` when resumed. Errors inside steps are caught and returned as data (e.g. `{ researchData: { error }, summary }`) rather than thrown, so the workflow always reaches the approval gate.

### Agents and the tools-delegate-to-agents pattern

There are 5 agents but only 2 are invoked directly by workflow steps (`researchAgent`, `reportAgent`). The other 3 are invoked **indirectly through tools** — a tool calls `context.mastra.getAgent('...')` and runs it. This is the key indirection to understand before changing agent wiring:

- `researchAgent` ([researchAgent.ts](src/mastra/agents/researchAgent.ts)) — the orchestrator. Holds the three tools below and follows a strict **two-phase process (initial queries → follow-up questions → STOP)**. The hard stop is deliberate cost/loop control and is enforced in *both* the agent instructions and the prompt in `researchStep`; preserve it when editing either.
  - `webSearchTool` → Exa search (`numResults: 2`), then summarizes each result through `webSummarizationAgent` to cut tokens.
  - `evaluateResultTool` → delegates to `evaluationAgent` for a `{ isRelevant, reason }` judgment.
  - `extractLearningsTool` → delegates to `learningExtractionAgent` for a learning + 1 follow-up question.
- `reportAgent` ([reportAgent.ts](src/mastra/agents/reportAgent.ts)) — no tools; turns approved `researchData` into the final markdown report.

So a single research run is agents-calling-tools-calling-agents. When you add an agent that a tool needs, it must be registered in `src/mastra/index.ts` or `getAgent('...')` returns undefined (tools handle this by returning an error result).

### Storage & observability

`src/mastra/index.ts` configures `LibSQLStore` at `file:../mastra.db` (relative to the `.mastra/output` build dir at runtime) and an `Observability` pipeline (`MastraStorageExporter` for Studio, `MastraPlatformExporter` for the Mastra platform when `MASTRA_PLATFORM_ACCESS_TOKEN` is set, `SensitiveDataFilter` to redact secrets). The `*.db` files and `.mastra/` are gitignored.

## Conventions

- Schemas are defined with **Zod**; workflow/step I/O and agent `structuredOutput` all use Zod schemas. Match this when adding steps or structured agent calls.
- The `.cursor/mcp.json` registers the `@mastra/mcp-docs-server` MCP server — Mastra documentation is available through it.
