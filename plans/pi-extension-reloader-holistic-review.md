# Holistic Codebase Review: pi-extension-reloader (integrated)

Date: 2026-08-30 · Reviewed at commit `5c73616` (v0.2.0)

**Provenance.** Original review by main@k3.com (k3 high). Per instruction, each of the
six angles was then repeated **independently** (reviewers were blind to the original
review) on **gpt-5.6-sol @ high** — six separate read-only reviewer agents, one per
angle. Kimi K3 subagents could not be spawned (broker rejects all mail to k3 addresses
with "exceeds the 0-byte context-safe envelope limit"), so all independent repeats ran
on the other qualifying model. Open questions were grounded by experiments against the
real Pi 0.84.2 runtime (`.test-workspaces/experiment*.js`) and by source verification in
`node_modules/@earendil-works/pi-coding-agent/dist`.

**Scope:** `index.ts` (187 lines), `tests/reloader.test.js`, `integration/e2e.js`,
`scripts/package-smoke.js`, packaging, docs, CI.

**Evidence gathered by main:** `npm test` → exit 0, `tsc --noEmit` → exit 0
(`.test-workspaces/review-*.log`); runtime experiments (below). Independent reviewers
were source-only (read/grep/find/ls) by design.

---

## Verdict

High-quality, release-ready extension. All six independent reviews concur: no
high-severity defect in the normal path; the overengineering review's verdict is
**rightly-engineered** (every core mechanism is forced by a real Pi 0.84.2 constraint).
The real issues cluster around **failure-path visibility**: ways the automatic
continuation can silently not happen. The fix plan below is deliberately minimal.

---

## Grounding experiments (main, real Pi runtime)

- **EXP2 (tool/command collision):** with a colliding third extension, commands become
  `reload-runtime:1`/`:2` (occurrence numbers) and `getAllTools()` shows exactly one
  `reload_runtime`. Pi-domain review confirmed from source: cross-extension duplicate
  tools are **first-registration-wins** (not last-wins) and conflicts are recorded in
  `extensionsResult.errors` (`runner.js:280-290`, `resource-loader.js:458-464`). → The
  current `sourceInfo.path` matching is **sound**; the matching tool and command always
  share one canonical sourceInfo object (`resource-loader.js:566-577`). No fix needed.
- **EXP3 (reload failure):** a syntax error in an edited extension does **not** fail
  `ctx.reload()` — Pi collects it into `extensionsResult.errors` and continues; the
  continuation fires anyway. Extension load errors are **not observable through the
  extension API** (only via `session.resourceLoader`, unavailable to extensions).
- **Abort:** `agent_settled` fires even for aborted runs — `_runAgentPrompt`'s
  `finally` is unconditional (`agent-session.js:744-755`), and `session.abort()`'s own
  `waitForIdle()` depends on it. Independently confirmed by two reviewers. A pending
  reload therefore fires immediately after an abort rather than hijacking a later run;
  there is no cancellation path (accepted behavior).
- **TUI vs RPC/print:** in TUI, `ctx.reload` is `handleReloadCommand()`, which catches
  reload errors and does **not** rethrow (`interactive-mode.js:4835-4869`); RPC/print
  bind `session.reload()` directly and do propagate.

---

## Consolidated findings (all reviews, deduplicated)

### A. Continuation can silently never happen (the one real cluster)

1. **Fresh instance never arms the callback** (independent: pidomain#1 high,
   agentic#1 high, correctness#3 medium, softeng#1 medium). If the reloader itself was
   edited into an unloadable state, Pi omits it, `session_start` never runs,
   `state.resume` stays undefined, and the old frame silently returns. PENDING persists;
   a later manual `/reload-runtime` recovers it (state + scan then work).
   → *Nothing in-process can report this — the reporter is the thing that's broken.*
   Minimal response: document the recovery path. (No code fix possible without new
   machinery.)
2. **DISPATCHED is written before fire-and-forget `sendUserMessage`** (correctness#1,
   agentic#2). Preflight failure (e.g. no API key) loses the continuation permanently.
   Already documented honestly in README. Platform limitation, no ack API in 0.84.2.
   → Keep documented; no fix.
3. **TUI swallows reload errors** (correctness#4, pidomain claim 5): the command's
   catch never runs in TUI; user sees Pi's own error; PENDING stays recoverable.
   → Document.
4. **Print/JSON single-shot modes may exit before the fire-and-forget continuation
   completes** (pidomain#2). → Document mode scope in README.
5. **Stale PENDING from a crash/failure can resume during a later unrelated manual
   reload** (correctness#2, agentic#3, softeng#1). Recovery semantics; arguably
   desirable. → Document, don't engineer startup-recovery machinery.

### B. Agent-facing semantics (small fixes, justified)

6. **Duplicate call looks like acceptance** (aiml#4, agentic#6, original §1.1). Second
   call returns success echoing the *first* request without saying it was ignored.
   → **Fix:** explicit "already scheduled; this call was ignored" in the coalesced
   result. Keep first-wins semantics (last-write-wins would add machinery).
7. **Reload-loop guard is prompt-only** (aiml#2). A fresh instance accepts an identical
   request right after a continuation. → **Fix (minimal structural guard):** store the
   request in the DISPATCHED entry; `execute()` (which receives `ctx` as 5th arg,
   verified) rejects an exact reason+continueWith duplicate of the last dispatched
   continuation with a recovery-minded error. ~15 lines.
8. **Model-authored fields are re-injected as a user message without delimiters**
   (aiml#1). → **Fix:** fence `reason`/`continueWith` in the continuation prompt.
   Trivial.
9. **`agent_settled` throw → extension_error + retry on every later settle**
   (correctness#7, original §1.4). Deliberate-ish but undocumented. → **Fix:** comment
   only; behavior is acceptable (surfaces diagnostics, retries).

### C. Confirmed non-issues (do not "fix")

- **Tool/command collision resolution is correct** (correctness + pidomain verified;
  first-registration-wins + shared canonical sourceInfo). Original §1.5 concern
  **withdrawn** — no import.meta.url path matching needed.
- **Abort does not strand state** — settle always fires (see experiments).
- **Duplicate-guideline "contradiction"** (original §1.1) is disputed by softeng
  review; downgraded to the UX wording fix in B6.
- globalThis bridge, two entry types + newest-first scan, double validation,
  provenance-based command lookup, test layering: all independently judged
  **justified** (overengineering review, 4×"justified" verdicts).
- `sendUserMessage` default `expandPromptTemplates:false` — correctly overridden.
- `terminate:true` batch semantics, concurrent-command coalescing, per-session bridge
  isolation — all verified correct.

### D. Out of scope for code (flagged to maintainer)

- Repo name `pi-extension-loader` vs package `pi-extension-reloader` (softeng#3).
  Renaming the GitHub repo is a user decision.
- `git:...@v0.2.0` install instructions need a real remote tag (softeng#2; no local
  tag refs exist). Maintainer release action.
- Optional simplifications, **rejected under the no-overengineering constraint**:
  package-smoke public-API refactor (overeng#1), e2e plumbing trim (overeng#2),
  dropping CONTRIBUTING/RELEASING from the tarball (overeng#3), e2e
  syntax-check/field-specific validation message (aiml#7), same-session-ID bridge
  collision (correctness#6, unsupported topology), global-name collision
  (pidomain#5).

---

## Minimal fix plan

1. `index.ts`:
   - execute(): when coalescing a duplicate, result text explicitly says the call was
     ignored and which continuation remains active. (B6)
   - DISPATCHED entry carries the request; execute() rejects an exact duplicate of the
     last dispatched continuation (loop guard), tolerating a missing `ctx`. (B7)
   - continuationPrompt(): fence model-authored `reason`/`continueWith`. (B8)
   - Comments: throw→extension_error→retry semantics; resume-missing recovery via
     later `/reload-runtime`. (B9, A1)
2. `tests/reloader.test.js`: update duplicate-call assertions (notice text), update the
   hardcoded continuation prompt to the fenced form, add loop-guard test through the
   real runtime (reload → identical call rejected), assert DISPATCHED carries data.
3. `README.md`: extend the limitations paragraph — fresh-instance load failure and TUI
   error swallowing (recover via `/reload-runtime`), print/JSON single-shot exit race,
   stale-PENDING recovery semantics. (A1, A3, A4, A5)
4. `CHANGELOG.md`: Unreleased entries for the above.
5. Validation: `npm run release:check` (log to `.test-workspaces/`), then
   `npm run test:e2e` if credentials permit.

Explicitly **not** done (per no-overengineering constraint): startup recovery of
orphaned PENDING entries, agent-notification plumbing for reload failures, last-write-
wins duplicate semantics, package-smoke/e2e refactors, collision-path hardening.
