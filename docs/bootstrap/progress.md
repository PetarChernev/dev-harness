# Bootstrap progress

Authority: [saved request](specification.md). Runtime task state will live in SQLite, not here. This document tracks the bootstrap implementation only.

| Phase | Acceptance | State / evidence |
|---|---|---|
| A | Environment/API inspected; schemas, CLI, fake adapter executable | Complete: strict TS build and 2 initial offline tests pass; `doctor` executes; installed SDK/server no-spend probe passed. See preflight.md. |
| B | Real persistence, scheduler/mail/recovery, Git verification/integration; offline acceptance suite | Complete initial increment: 13 offline tests pass using real Git, SQLite and subprocesses; production mock demo passes with two-way acknowledged mail, alpha continuation, independent and combined checks, serialized commits. |
| C | SDK adapter + scoped API/tools; bounded live demo with truthful result | Pending |
| D | Pack/install proof, neutral Rust/Bevy starter, checks, runbook, audit | Pending |

## Blockers

- No blocker to generic offline implementation. Pinned local Node installed; Git identity already available.
- Effective model selection and real graphical execution need separate live checks.

## Next concrete action

Implement Phase C SDK runtime and protected custom tools, then run the bounded live demo. Expand CLI/packaging and acceptance coverage in Phase D. Activate local Node PATH as documented in preflight.md.

## Evidence

- Phase A commit: `0814099`.
- Phase B reproduction: `npm run build:harness && npm run test:harness` (13 tests, 2026-09-28).
- Mock production workflow: `npm run harness -- demo --repo /tmp/opencode/harness-phase-b-demo --mode mock` passed. Evidence: `/tmp/opencode/harness-phase-b-demo/.git/harness/demo-report.json`; 2 tasks done, alpha 2 prompts/beta 1, no pending mail/unresolved actions, owned processes stopped. Use a new empty path to reproduce.
