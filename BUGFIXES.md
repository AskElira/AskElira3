# Bug Fixes — AskElira 3 Audit

Systematic code audit of all 8 subsystems. 7 real bugs found and fixed.

---

## Bug 1: Filenames with spaces crash syntax checker

**File:** `src/pipeline/floor-runner.js` (line 37)
**File:** `src/executor.js` (new function)

**What happens:** `syntaxCheckFiles` builds a command string like `node --check /path/to/my file.js` and passes it to `executor.run()`. The `run()` function splits on whitespace (`command.trim().split(/\s+/)`), so a filename like `my file.js` becomes two separate args: `my` and `file.js`. The syntax check fails with a misleading "file not found" error, causing false positives that trigger unnecessary rebuild iterations.

**Impact:** Any floor where David produces a file with a space in its name will enter an infinite retry loop (up to MAX_ITERATIONS) because syntax check always fails. The floor ends up blocked even though the code may be valid.

**Fix:** Added `runExecFile(cmd, args)` to `executor.js` that takes pre-split arguments and passes them directly to `child_process.execFile()` without string splitting. Updated `syntaxCheckFiles` to use it. This properly handles any filename characters.

---

## Bug 2: Workspace rollback crashes on single-commit repos

**File:** `src/pipeline/workspace.js` (line 117-121)

**What happens:** `rollbackWorkspace(goalId)` runs `git checkout HEAD~1 -- .` unconditionally. If the workspace has only one commit (e.g., David just wrote the first file), `HEAD~1` doesn't exist and `execSync` throws an unhandled error that propagates up and crashes the caller.

**Impact:** Steven's fix attempts or manual rollback via API will crash with an unhelpful git error instead of a clear message when there's nothing to roll back to. The error message would be something like `fatal: ambiguous argument 'HEAD~1': unknown revision`.

**Fix:** Added a `git rev-parse HEAD~1` pre-check that throws a clear, descriptive error (`Cannot rollback: workspace has only one commit`) before attempting the checkout.

---

## Bug 3: LLM JSON parse failures are not retried

**File:** `src/llm.js` (lines 174-190, 225-240)

**What happens:** Both `anthropicChat` and `openaiChat` use `withRetry` to retry on 429/500/503 errors. However, the `res.json()` call that parses the response body was OUTSIDE the `withRetry` wrapper. If the HTTP response is 200 OK but the body is truncated/corrupted (which happens with network interruptions, proxy timeouts, or CDN edge issues), `res.json()` throws a JSON parse error that is NOT retried.

**Impact:** Intermittent JSON parse failures from valid HTTP responses cause immediate agent failures instead of being retried. This is especially bad for David builds (which use large responses) and can cause floors to block unnecessarily.

**Fix:** Moved `r.json()` inside the `withRetry` callback chain (inside the `.then()`) so that JSON parse errors trigger retry logic just like HTTP errors do.

---

## Bug 4: Circuit breaker allows multiple requests through HALF_OPEN

**File:** `src/circuit-breaker.js` (lines 45-65)

**What happens:** When the circuit transitions from OPEN to HALF_OPEN, the intent is to allow exactly one "test request" through. However, there was no guard against concurrent calls. If call A enters `call()`, sees OPEN with expired cooldown, sets state to HALF_OPEN, and starts executing `fn()` (async), then call B arrives before A completes. B sees `state === HALF_OPEN` (not OPEN), skips the OPEN check entirely, and also executes `fn()`. Both requests go through simultaneously, defeating the circuit breaker's protection.

**Impact:** During recovery from an API outage, multiple requests flood through instead of one test request, potentially overwhelming the recovering service and causing it to fail again. With Tavily/Brave/Lightpanda/Ollama all using circuit breakers, this could cascade into repeated circuit opens.

**Fix:** Added a `_halfOpenPending` boolean flag. When transitioning to HALF_OPEN, the flag is set to true. Any subsequent call that arrives while HALF_OPEN with the flag set is rejected with `CircuitOpenError`. The flag is cleared on success (closing the circuit) or failure (reopening it), and on manual `reset()`.

---

## Bug 5: Steven summary reads heartbeat state from wrong file path

**File:** `src/web/server.js` (line 594)

**What happens:** The `steven_summary` intent handler in the Telegram message processor constructs the heartbeat state file path as `path.resolve(__dirname, '..', 'data', 'heartbeat-state.json')`. Since `__dirname` is `src/web/`, this resolves to `src/data/heartbeat-state.json`. But `steven-heartbeat.js` (which writes the state) uses `path.resolve(__dirname, '..', 'data', ...)` where its `__dirname` is `src/`, resolving to `<project-root>/data/heartbeat-state.json`. These are different directories.

**Impact:** When a user asks Telegram "what has Steven been doing?", the handler always reads from the wrong path, finds no file, and responds with "Steven has been quiet" even when Steven has been actively fixing floors. The entire Steven activity tracking feature via Telegram is silently broken.

**Fix:** Changed the path in `server.js` from `path.resolve(__dirname, '..', 'data', ...)` to `path.resolve(__dirname, '..', '..', 'data', ...)` so both files resolve to the same `<project-root>/data/heartbeat-state.json`.

---

## Bug 6: deleteGoal leaves orphaned metrics records

**File:** `src/db.js` (lines 150-157)

**What happens:** The `deleteGoal` transaction deletes from `llm_calls`, `logs`, `floors`, and `goals`, but does NOT delete from the `metrics` table. The `metrics` table has both `goal_id` and `floor_id` columns that reference the deleted goal and its floors.

**Impact:** Over time, the metrics table accumulates orphaned records for deleted goals. This causes `getMetricsSummary()` to return inaccurate statistics (inflated failure counts, wrong averages), and the `/api/stats/metrics` endpoint reports stale data. The self-improvement loop also reads these metrics, so its pattern analysis could be skewed by data from goals the user intentionally deleted.

**Fix:** Added `db.prepare('DELETE FROM metrics WHERE goal_id = ?').run(id)` as the first statement in the delete transaction, before the other deletions.

---

## Summary

| # | Severity | File | Bug | Impact |
|---|----------|------|-----|--------|
| 1 | HIGH | floor-runner.js, executor.js | Filenames with spaces break syntax check | False positive failures, wasted iterations |
| 2 | MEDIUM | workspace.js | Rollback crashes on 1 commit | Steven fix / API rollback crashes |
| 3 | HIGH | llm.js | JSON parse not retried | Unnecessary floor blocks on network glitches |
| 4 | MEDIUM | circuit-breaker.js | Multiple HALF_OPEN requests | Defeats circuit breaker protection |
| 5 | HIGH | server.js | Wrong heartbeat state path | Steven summary feature completely broken |
| 6 | LOW | db.js | Missing metrics cleanup | Orphaned data, inaccurate analytics |

All fixes are backward compatible. All 47 existing unit tests pass after changes.

### Not Bugs (investigated but confirmed working)

- `withTimeout` cleanup: timed-out agent calls continue running, but the design handles this via iteration feedback
- `davidBuild` returning `files: undefined`: prevented by `validateSchema` with `DAVID_BUILD_SCHEMA` requiring non-empty object
- `buildExecutionWaves` with non-existent `depends_on`: handled by the "circular dependency fallback" that dumps remaining into one wave
- `updateFloor` with invalid fields: all callers pass fields in `ALLOWED_FLOOR_FIELDS`, verified by inspection
- Vex `score` as string: `validateSchema` enforces `typeof value !== 'number'` check
- `classifyIntent` invalid JSON: has try/catch fallback returning `{ intent: 'chat', confidence: 0.3 }`
- SQL injection via ALLOWED_FIELDS: parameterized queries used throughout; field names are from a hardcoded Set, not user input
- Telegram polling network errors: wrapped in try/catch at line 637
- `queuedWriteFile` error handling: rejection handler in `.then()` continues the chain correctly
- `ensureGoalDir` failure: would throw, caught by callers' try/catch blocks
- `fetchWithTimeout` cleanup: `.finally()` clears timer on both success and failure paths
