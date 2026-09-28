# Live OpenCode smoke evidence

Actual local run on 2026-09-28, **not mock validation**.

```sh
npm run build:harness
npm run harness -- demo --repo /tmp/opencode/harness-phase-c-live-3 --mode live
```

Use a **new absent/empty directory** to repeat. No provider was added or changed. The existing recent selection `openai/gpt-6-astra` was validated against the connected provider's model inventory and explicitly pinned per session. Existing credentials were used without copying or printing them.

| Evidence | Observed |
|---|---|
| OpenCode / SDK | 1.18.33 / 1.18.33 (`@opencode-ai/sdk/v2`) |
| Worker sessions | alpha `ses_f16e1d79bffehpM2ACEXmnK1LM`; beta `ses_f16e1d04cffe7ft0jLsuNe0PfM` |
| Mail | `smoke_question` alpha→beta; `smoke_answer` beta→alpha; both acknowledged; no pending mail |
| Continuation | alpha 2 prompts; first turn intentionally blocked without creating file; supervisor dispatched concrete second turn |
| Submission | alpha `dcccf67a52ae6b38f7cff455b4102974a986bcf6`; beta `019ebf82455ac6a218b0cac0490624410992e18e` |
| Verification | fresh candidate command checks, required artifacts retained; combined checks rerun for each integration |
| Integration target result | `a617b7492754be3c4c67c76bafc5162cadebba60`; both tasks `done`; user's `main` preserved |
| Consumption | alpha reported 54,150 tokens; beta 35,516 (includes cache/step usage); monetary cost **unknown**, not zero |
| Limits | 2 implementation slots, 1 verifier, 2 build jobs; each task ≤5 prompts, 12 steps/prompt, 2 attempts, 240 seconds, 60,000 reported tokens, $2 when observable; no unbounded retries |
| Cleanup | `ownedProcessesStopped: true`; no unresolved actions; supervisor stopped |
| Full durable local evidence | `/tmp/opencode/harness-phase-c-live-3/.git/harness/demo-report.json`, `state.sqlite`, `artifacts/`, `servers/*/effective-summary.json` |

The budget is a supervisor observation/enforcement limit, **not a provider-side billing cap**. In-flight steps can consume usage before it is observed. This provider reported no monetary price; the money limit could not act as a hard spend cap. Prompt/step/time/attempt limits remained finite.

## Compatibility discovery

The first two probes stopped before any model prompt because the effective permission audit detected an appended OpenCode built-in rule allowing its truncation-output directory. Evidence was preserved in `/tmp/opencode/harness-phase-c-live-1` and `...-2`; owned processes were terminated. The adapter now recognizes only that exact installed-version rule and separately verifies the exact session permission list overriding inherited permissions. Unexpected inherited grants still fail closed. The startup failure path now records confirmed process termination rather than retaining an ambiguous owner after confirmed cleanup.

Live semantic reviewer/planner calls and live permission approval are separately bounded but are not established by this two-worker smoke. The offline SDK contract tests exercise request shapes, identity scoping, in-flight exclusion and permission-list handling. The no-spend probe tests the actual installed 401/404/204 behavior.

Repo-local OpenCode configuration is loaded at startup. **Quit and restart OpenCode** to load the new root agents, tools and `/harness-status`, `/harness-plan`, `/bootstrap-resume` commands.
