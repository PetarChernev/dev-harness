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

## ADR-005 — Portable lock and build identity (accepted)

Ship npm-shrinkwrap.json in the tarball to pin transitive dependencies. The build records source Git revision/dirty state, Node version and dependency-lock digest; runtime records the compiled module/content identity. npm can consume the installed shrinkwrap, so runtime uses the retained build digest when the file is absent. Tool source is snapshotted at runtime construction and its plugin import is resolved against the installed package, including hoisted layouts.

## ADR-006 — Generic command resource accounting (accepted)

Approved worker checks and independent/combined verification share command-level build/graphical capacity. Stable worker request IDs deduplicate polling/retries. Language-specific environment settings live in profile `executionEnv` with explicit generic placeholders; Cargo is not scheduler logic. A launcher hook preserves executable/argument boundaries but does not supply isolation. Permissions deny direct supervised compiler/agent-tree commands; arbitrary operator-approved host commands are outside hard OS accounting guarantees.

## ADR-007 — Neutral starter and rendering gate (accepted)

Pure Rust project_core uses seeded integer motion and explicit ticks. Desktop and headless call the same core. Default Cargo members exclude desktop. Bevy/Rust are pinned at 0.19.1/1.95.0; default features are disabled, no audio/assets/nightly optimizations are selected. Baseline replay tests and sample inputs are protected policy material. Finite desktop smoke uses no-VSync to avoid local compositor throttling, preserves a screenshot, and compares its core digest with headless output.

## ADR-008 — Approval baseline and repository identity (accepted)

Task bases precede the commit recording their plan. Therefore approval captures the committed operator baseline separately; integration combines that approved baseline and the submitted change on the latest target before rerunning checks. This preserves plan/policy commits and makes explicit fast-forward promotion work without rewriting the user's checkout. Promotion requires recorded verified integration evidence. Canonical runtime directories and backups are bound to their repository; automatic relocation/cross-repository state adoption is deferred.
