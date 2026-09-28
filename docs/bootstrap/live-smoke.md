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

## Portable-package live proof (Phase D)

The tarball was installed into a separate npm repository using `npm install --offline --ignore-scripts`. Its standalone executable then ran the real workflow:

```sh
/tmp/harness-package-proof-kDLV7A/installer/node_modules/.bin/harness \
  demo --repo /tmp/opencode/harness-packaged-live-final --mode live
```

Result **passed**. Alpha used 3 prompts, beta 2, including calls to the added `harness_check` tool. Those calls executed approved command IDs through the production shared build-job limiter and persisted stable action IDs; fresh independent verification and combined checks ran again after submission.

- Sessions: alpha `ses_f16be37f8ffexJ5LQdgw7SdCJX`, beta `ses_f16be30dbffeuxexSM0vdHNUtV`.
- Final integration commit: `06d85a038b12512d62f1679f4370005f53be0c17`.
- Same addressed question/answer IDs, both acknowledged; no pending mail or unresolved actions.
- **In-flight token overage observed:** alpha 76,171 and beta 72,665 reported tokens against 60,000 per-task observation limits. The final in-flight turns submitted their results; no further model prompts were dispatched. Status now explicitly reports such overages. These are not hard provider-side token/spend caps. Monetary prices remained **unknown**.
- All owned processes stopped. Full evidence: `/tmp/opencode/harness-packaged-live-final/.git/harness/demo-report.json` and its runtime SQLite/artifact/server records.

## Actual installed permission/resumption probe

```sh
node tools/harness/scripts/permission-probe.mjs
```

Observed **passed** with one existing-model prompt, 2 steps and a 45-second cap. The server exposed a scoped pending **bash** request for harmless `printf compatibility-probe`. The probe **rejected** it, verified an empty pending list, and stopped the owned process. It never auto-approved a request. The same session resumed as `owned` before dispatch.

Evidence: `/tmp/harness-permission-probe-2jaFiT/report.json`; session `ses_f16a9f1a0ffeNn5eQmaZaBlnZw`; permission `per_0e9562a80001XLF1EDXyk98y8y`. This validates actual installed request/list/reject/resumption shapes in addition to the 401/404/204 no-spend probe and offline contract tests. Live crash recovery and full planner/reviewer model behavior are still separate from these bounded probes.

## Final committed-release validation

The final implementation was built and packed from **clean committed source** `f602de4de94c26bea29e24c3adc007b327d5a0f2` (recorded `sourceDirty: false`). The installed tarball then passed another bounded real two-session workflow:

```sh
/tmp/opencode/harness-package-proof-v13wlV/installer/node_modules/.bin/harness \
  demo --repo /tmp/opencode/harness-release-final-proof --mode live
/tmp/opencode/harness-package-proof-v13wlV/installer/node_modules/.bin/harness \
  promote --repo /tmp/opencode/harness-release-final-proof --target main
```

| Final evidence | Result |
|---|---|
| Compiled/tool release hash | `ebd44d96d435deabf202a90b56e1fa55d17685554efd1007a25c527838000d43` |
| Package integrity | `sha512-4/mJUHeq0hndXOfovLCezHEMcbHc/K+9cFzyxBcn4RIo8n+wpzqCs7E7HaEY4XpdFWIKH6UovLEqbb5rTRHWiQ==` |
| Alpha session | `ses_f165b9868ffekxKixyEtuGGDnR`, 3 prompts, 77,005 reported tokens |
| Beta session | `ses_f165b8d7bffe7koQI45w89BPwy`, 2 prompts, 73,252 reported tokens |
| Mail | Both addressed smoke messages acknowledged; no pending mail |
| Checks | Worker-command checks, separate fresh verification, and latest-candidate combined checks passed |
| Integration / explicit disposable promotion | `f6be14df23bb4d7e187e6c89aebbdaf2907fd9a5` |
| Cleanup | Both workers stopped, supervisor stopped, no unresolved actions |
| Full evidence | `/tmp/opencode/harness-release-final-proof/.git/harness/demo-report.json` |

The final in-flight turns exceeded the 60,000-token observation allowance by 17,005 and 13,252 tokens respectively. These overages are explicit in status; there were no later model prompts. Monetary usage remains unknown. The explicit promotion affected **only the disposable demo repository**, not this bootstrap checkout.

The same package is available locally at `.local/local-first-dev-harness-0.1.0.tgz`. Portable offline installation proof is `/tmp/opencode/harness-package-proof-v13wlV/proof.json`.
