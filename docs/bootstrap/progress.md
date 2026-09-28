# Bootstrap progress

Authority: [saved request](specification.md). Runtime task state will live in SQLite, not here. This document tracks the bootstrap implementation only.

| Phase | Acceptance | State / evidence |
|---|---|---|
| A | Environment/API inspected; schemas, CLI, fake adapter executable | Complete: strict TS build and 2 initial offline tests pass; `doctor` executes; installed SDK/server no-spend probe passed. See preflight.md. |
| B | Real persistence, scheduler/mail/recovery, Git verification/integration; offline acceptance suite | Complete initial increment: 13 offline tests pass using real Git, SQLite and subprocesses; production mock demo passes with two-way acknowledged mail, alpha continuation, independent and combined checks, serialized commits. |
| C | SDK adapter + scoped API/tools; bounded live demo with truthful result | Implemented; real two-session smoke passed. See live-smoke.md for exact commits, mail, budgets, usage and cleanup. |
| D | Pack/install proof, neutral Rust/Bevy starter, checks, runbook, audit | Complete. 37 offline tests pass, also without global/system Git config. Clean committed-release packaging/live workflow/promotion passed; Rust/replay/desktop screenshot gates passed. Full status/reproduction matrix: audit.md. |

## Blockers

- No blocker to generic offline implementation. Pinned local Node installed; Git identity already available.
- No blocker to authorized bootstrap completion. Existing-model live mail/continuation/checks and actual permission rejection/resumption are validated.
- Monetary price is unavailable for the configured provider; observed in-flight token overage is documented. This is not a hard billing cap.
- Live planner/reviewer behavior, live crash fault injection, non-Linux operation and actual sandbox isolation remain unverified; offline contract/recovery tests cover their implemented program boundaries. CI definitions have not run remotely.

## Next concrete action

Bootstrap implementation is complete. For new supervised work, review `.harness/plans/starter-proof.yaml`, then explicitly approve/resume/run it using `docs/runbook.md`. It is already imported as an unapproved draft, with zero attempts/prompts. The root supervisor is stopped. Quit/restart OpenCode to load repo-local configuration. No owned process is intentionally left running.

## Evidence

- Phase A commit: `0814099`.
- Phase B reproduction: `npm run build:harness && npm run test:harness` (13 tests, 2026-09-28).
- Mock production workflow: `npm run harness -- demo --repo /tmp/opencode/harness-phase-b-demo --mode mock` passed. Evidence: `/tmp/opencode/harness-phase-b-demo/.git/harness/demo-report.json`; 2 tasks done, alpha 2 prompts/beta 1, no pending mail/unresolved actions, owned processes stopped. Use a new empty path to reproduce.
- Phase B commit: `67f4c83`; Phase C commit: `ed9c149`.
- Phase D starter/template commit: `34c11ae`; the example plan pins that explicit code base.
- Final implementation/audit commit: `f602de4`; compiled and packed from clean source at that revision.
- Latest portable proof: `/tmp/opencode/harness-package-proof-v13wlV/proof.json`; standalone installed generic workflow passed using cached offline npm dependencies. Distributable: `.local/local-first-dev-harness-0.1.0.tgz`.
- Final committed-release live proof: `/tmp/opencode/harness-release-final-proof/.git/harness/demo-report.json`, passed. Explicit promotion in that disposable repo passed at `f6be14df23bb4d7e187e6c89aebbdaf2907fd9a5`; both owned workers stopped. In-flight token overages/unknown prices are recorded in live-smoke.md.
- Repo-local custom tools in a fresh dependency-free Git checkout: `.git/harness/worktree-api-probe.json` passed with zero model calls, successful ownership resumption and confirmed shutdown.
- Actual permission rejection/resumption: `/tmp/harness-permission-probe-2jaFiT/report.json` passed; owned process stopped.
- Headless replay: `artifacts/replay/replay.json`, digest `a0e4a7d818ae130b1c9130a8c8d1635c5358ebd7f155c41853abf61084b247c9`.
- Desktop: `artifacts/desktop/smoke.json`, screenshot `artifacts/desktop/frame-d1b62d78-67e2-417a-b03d-ea74b5d152b8.png`, same core digest. Final formatting, desktop/core/headless Clippy and four Rust tests passed.
- Root runtime snapshot: stopped, one unapproved draft, no workers/mail/actions. Online backup: `.local/bootstrap-state.sqlite`. No owned OpenCode server processes found after the final probes.
