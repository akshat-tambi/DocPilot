# DocPilot Worker Package

Background workers handle scraping, text processing, and (eventually) embedding jobs that power DocPilot’s retrieval pipeline.

## Testing Strategy

We’ll exercise the worker with a blend of unit, integration, and contract-style tests using Vitest. The plan below keeps the feedback loop quick while still covering the tricky edge cases around async crawling and IPC.

### 1. Unit Coverage

- **Queue orchestration (`enqueueLink` / `processUrl`)** – Stub the fetcher and assert depth/page guards, domain allow-lists, and cancellation paths.
- **Parsing helpers** – Mock HTML/Markdown inputs to verify heading extraction, content stripping, and merge behaviour for empty/short pages.
- **Chunking integration** – Use deterministic text fixtures and assert chunk + summary payloads match the shared utilities’ expectations.

Tooling: Vitest with fake timers, `vi.spyOn` for queue internals, and lightweight fixtures in `worker/test/fixtures`.

### 2. Integration Coverage

- **Fetch + parse happy path** – Spin up a local HTTP server (via `undici`’s `MockAgent`) to feed controlled HTML trees, then assert emitted `page-result` / `page-progress` messages.
- **Markdown fallback** – Serve `.md` responses and confirm the unified pipeline strips markdown syntax correctly.
- **Failure handling** – Return 4xx/5xx responses and malformed HTML to ensure `failed`/`skipped` progress events surface with reasons.

These tests run the real `processUrl` flow inside the worker, but mock outbound fetches to avoid network flakiness.

### 3. IPC Contract Tests

- Launch the worker in-process with `new Worker()` and a mocked parent port to verify message shapes against `WorkerEventMessage` (including `worker-error`).
- Assert cancellation and completion life-cycle events arrive in the correct order when the queue drains.

### 4. Tooling & Automation

- Add a `worker/vitest.config.ts` with Node + worker environment defaults.
- Provide npm scripts (`pnpm --filter worker test:unit`, `test:integration`) so CI can run targeted suites.
- Wire coverage reporting (istanbul) once behavioural tests land, targeting >80% statements for the worker package.

### 5. Manual Smoke

Until the extension bridge is wired, expose a debug CLI (behind a script) that boots the worker with a single URL, outputting emitted events to stdout. This helps sanity-check live sites when diagnosing parsers.

---

As we begin implementing the tests above, keep commits scoped (e.g., “add worker unit harness”, “cover html parsing”) so regressions stay easy to bisect.
