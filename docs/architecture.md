# Architecture

Local-first trusted-local execution. The independently packaged TypeScript engine uses SQLite WAL and a single owner lock. Immutable specification revisions and approved policy snapshots are separate from mutable execution records. An authenticated loopback service is the only worker mutation boundary. CLI maintenance acquires the same owner lock when the supervisor is stopped.

The engine controls scheduling, leases, budgets, mail, Git workspaces, command verification and serialized integration. A typed runtime interface is implemented by a deterministic fake and the official OpenCode SDK adapter. Profiles contain only templates, role instructions, commands and policy. No application domain concepts belong in the engine.

Runtime state lives under the repository's canonical Git common directory, outside all linked worker checkouts. Worktrees, commands and owned servers have durable action records. Uncertain dispatch/process ownership is paused, never treated as permission to retry. Notification streams accelerate observation; session history and Git are reconciliation authorities.

The supervisor loads a compiled release snapshot before work starts. Policy and command definitions are pinned by milestone approval. A harness upgrade requires drain/stop, rebuilding and restart. Workers do not get operator credentials. Host processes, worktrees and permissions are not a security sandbox.
