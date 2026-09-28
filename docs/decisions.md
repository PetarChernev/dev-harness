# Decision record

## ADR-001 — Local durable supervisor (accepted by bootstrap scope)

TypeScript + pinned Node LTS, SQLite via better-sqlite3, Zod boundary schemas, npm lockfiles, Vitest. One process owns mutations; loopback API and scoped capabilities connect workers. No distributed infrastructure.

## ADR-002 — Conservative uncertainty (accepted)

Intent precedes external action. Prompt identities persist before asynchronous dispatch. Reconcile session history before continuation. An unobservable action pauses for operator reconciliation; arbitrary external commands are not exactly-once.

## ADR-003 — Git candidate integration (accepted)

Independent detached verification checkouts and serialized merge candidates. Compare-and-swap advances a harness-owned branch only after combined checks. User branch promotion is explicit. Dirty/failed/conflicted work is preserved.

## ADR-004 — Profiles are data/templates (accepted)

Generic commands require no Rust. Rust/Bevy is the first template, with headless-safe default members and separately selected graphical checks. No game design is in scope.

## Approval records

Material task/interface/policy changes need a versioned proposal and new milestone approval. Approval records are appended here or in a dedicated versioned decision file and imported with the revision. Runtime messages alone never amend approved criteria.
