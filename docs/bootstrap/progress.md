# Bootstrap progress

Authority: [saved request](specification.md). Runtime task state will live in SQLite, not here. This document tracks the bootstrap implementation only.

| Phase | Acceptance | State / evidence |
|---|---|---|
| A | Environment/API inspected; schemas, CLI, fake adapter executable | Complete: strict TS build and 2 initial offline tests pass; `doctor` executes; installed SDK/server no-spend probe passed. See preflight.md. |
| B | Real persistence, scheduler/mail/recovery, Git verification/integration; offline acceptance suite | Complete initial increment: 13 offline tests pass using real Git, SQLite and subprocesses; production mock demo passes with two-way acknowledged mail, alpha continuation, independent and combined checks, serialized commits. |
| C | SDK adapter + scoped API/tools; bounded live demo with truthful result | Implemented; real two-session smoke passed. See live-smoke.md for exact commits, mail, budgets, usage and cleanup. |
| D | Pack/install proof, neutral Rust/Bevy starter, checks, runbook, audit | Implementation verified: 34 offline tests pass, including schema migrations through v3 and revision-scoped attempt history. Portable offline install + generic workflow and packaged live workflow passed. Rust core/headless/replay, desktop build/lint/render screenshot passed. Final handoff/commit in progress. |

## Blockers

- No blocker to generic offline implementation. Pinned local Node installed; Git identity already available.
- No blocker to authorized bootstrap completion. Existing-model live mail/continuation/checks and actual permission rejection/resumption are validated.
- Monetary price is unavailable for the configured provider; observed in-flight token overage is documented. This is not a hard billing cap.
- Live planner/reviewer behavior, live crash fault injection, non-Linux operation and actual sandbox isolation remain unverified; offline contract/recovery tests cover their implemented program boundaries. CI definitions have not run remotely.

## Next concrete action

Commit the verified Phase D implementation, add the example starter-proof plan at that exact base, probe repo-local custom tools in a dependency-free worker checkout, finalize audit, and verify clean status/owned-process cleanup. Activate local Node PATH as documented in preflight.md.

## Evidence

- Phase A commit: `0814099`.
- Phase B reproduction: `npm run build:harness && npm run test:harness` (13 tests, 2026-09-28).
- Mock production workflow: `npm run harness -- demo --repo /tmp/opencode/harness-phase-b-demo --mode mock` passed. Evidence: `/tmp/opencode/harness-phase-b-demo/.git/harness/demo-report.json`; 2 tasks done, alpha 2 prompts/beta 1, no pending mail/unresolved actions, owned processes stopped. Use a new empty path to reproduce.
- Phase B commit: `67f4c83`; Phase C commit: `ed9c149`.
- Latest portable proof: `/tmp/opencode/harness-package-proof-0WgtG6/proof.json`; standalone installed generic workflow passed using cached offline npm dependencies. Earlier packaged live proof and exact sessions/commits are in live-smoke.md.
- Actual permission rejection/resumption: `/tmp/harness-permission-probe-2jaFiT/report.json` passed; owned process stopped.
- Headless replay: `artifacts/replay/replay.json`, digest `a0e4a7d818ae130b1c9130a8c8d1635c5358ebd7f155c41853abf61084b247c9`.
- Desktop: `artifacts/desktop/smoke.json`, screenshot `artifacts/desktop/frame-4f469f60-d618-4ea1-b6eb-e042291c2b56.png`, same core digest. Desktop/core/headless Clippy and four Rust tests passed.
