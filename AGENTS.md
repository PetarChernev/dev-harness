# Repository guide

- User authority: `docs/bootstrap/specification.md`; bootstrap handoff: `docs/bootstrap/progress.md`.
- Harness design and boundaries: `docs/architecture.md`, `docs/operating-protocol.md`, `docs/decisions.md`.
- Operation and recovery: `docs/runbook.md`; compatibility: `docs/bootstrap/preflight.md`.
- Approved project policy: `.harness/project.yaml`; versioned plans: `.harness/plans/`.
- Harness package: `tools/harness/`. Application code must not be imported by it.
- Runtime status comes from `npm run harness -- status --repo .`, never a second text task list.
- Preserve work and user checkout; do not push. Supervised workers must use harness mail and cannot spawn unmanaged agents.
