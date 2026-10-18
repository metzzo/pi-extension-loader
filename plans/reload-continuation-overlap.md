# Reload continuation lost to an overlapping notification

## Finding and proposed correction

The reload callback writes `dispatched-continuation` and calls
`pi.sendUserMessage()` without a delivery mode. Another extension can start a
notification turn during the reload lifecycle. Pi then rejects the continuation:

> Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.

Use `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` at this existing call
site. This is now implemented locally with real SDK regressions. It uses Pi's
queue; it adds no scheduler, retry, acknowledgment protocol, or alternate agent.

## Evidence

The PSE parent session `01a1423c-c3d1-72bf-9991-16e626794f08` contains five
reload-result → mail notification → dispatched marker → assistant-stop sequences
without an automatic-continuation user message. Two successful reloads have that
user message. The association alone does not prove the exact cause of every
historical interruption.

An offline reproduction with Pi 0.84.2 loaded this actual extension and a second
extension using the real `sendMessage` API during `session_start(reason=reload)`.
The maintained `pi-ai` provider test kit held the notification's model response.
The callback produced the error above, two provider calls, pending/dispatched
entries, and no next action. No network model or PSE operator run was launched.
The owner regressions reproduce the same refusal on its locked Pi 0.87.1 baseline.

PSE retains the diagnostic script and result under
`package-artifacts/project-scaffolding-operator/reproduce-reload-overlap.mjs`
and `reload-overlap-result.json`, plus the session-derived `reload-trace.json`.
Its `package-artifacts/reload-owner-behavior-red-final.log` records two behavioral
failures before the correction; idle and missing-tool controls already passed.
Earlier module-resolution and provider-tool-projection fixture errors are retained
separately, not counted as behavioral failures.

## Acceptance and limits

`tests/reloader.test.js` prompts a real SDK session once. The model invokes the
actual reload tool; automatic continuation invokes a newly loaded tool without a
manual second prompt. Held resource discovery proves ordering. A held notification
proves queue admission, and STOP reaches the resumed request without being lost.
A failed changed extension remains unavailable. Exact repeat reload is rejected.
The scripted provider verifies transport and context, not every model's reasoning.

A dispatched marker still is not an acknowledged append or proof of action.
Process exit, queue clearing, or another preflight error can prevent delivery;
none authorizes replay. Consumers must inspect existing operations and receipts
before deciding what to do next. The PSE warm-session integration should exercise
that independent contract with native tools, not substitute a manual prompt for
this automatic path.

Run `npm run release:check` for deterministic validation. The authenticated
`test:e2e` is not run for this investigation: the authorizing workflow explicitly
excludes paid qualification without separate approval. This is not a release or
a claim of live-model qualification.
