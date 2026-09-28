# Bootstrap progress

Authority: [saved request](specification.md). Runtime task state will live in SQLite, not here. This document tracks the bootstrap implementation only.

| Phase | Acceptance | State / evidence |
|---|---|---|
| A | Environment/API inspected; schemas, CLI, fake adapter executable | Complete: strict TS build and 2 initial offline tests pass; `doctor` executes; installed SDK/server no-spend probe passed. See preflight.md. |
| B | Real persistence, scheduler/mail/recovery, Git verification/integration; offline acceptance suite | Pending |
| C | SDK adapter + scoped API/tools; bounded live demo with truthful result | Pending |
| D | Pack/install proof, neutral Rust/Bevy starter, checks, runbook, audit | Pending |

## Blockers

- No blocker to generic offline implementation. Pinned local Node installed; Git identity already available.
- Effective model selection and real graphical execution need separate live checks.

## Next concrete action

Implement Phase B persistence and real Git/subprocess boundaries, then add recovery/communication acceptance tests before live adapter implementation. Activate the local Node PATH as documented in preflight.md.
