# Operating protocol

## Authority and roles

Versioned `.harness/project.yaml` and `.harness/plans/*.yaml` are reviewed inputs. Import creates immutable SQLite revisions; approval binds the milestone's included revisions, executable command definitions, resource policy and finite limits. The CLI requires exact committed plan/policy before approval. Changing an imported revision in place is rejected. A newer revision invalidates old evidence and dependent approvals. An export/status response is a snapshot, never a second editable task list.

Planner proposes drafts; implementer/researcher executes approved scope; reviewer inspects an immutable candidate. The engine decides scheduling and completion. Sessions are replaceable. The worker can checkpoint, ask, block and submit; only the independent verification/integration pipeline can reach `done`. A research task requires a report/experiment artifact even when application code is unchanged.

## State transitions and retries

Normal path: `draft -> ready -> running -> submitted -> verifying -> integration -> done`.

- `draft -> ready` requires operator milestone approval.
- `ready` claims require exact dependency revisions at `done`, implementation capacity and all named locks. Claims are transactional.
- `running -> blocked` is addressed-agent waiting; `running -> needs_human` covers human decisions, permissions, uncertain ownership and exhausted limits. Waiting releases implementation capacity; an existing busy session never receives a competing prompt.
- Completed turns without submission receive a concrete revision/acceptance/mail/evidence/limits prompt. Narration/checkpoint text alone is not meaningful progress. Dirty Git/artifact changes, command evidence, acknowledgements and resolved dependencies are progress signals. A busy tracked session/build is not idle.
- Verification failure returns to `ready` with preserved checkout and reproducible logs. Combined-check failure also returns to `ready`; conflicts/uncertainty go to `needs_human` with the candidate preserved.
- `blocked -> running` reacquires capacity at a safe boundary when an addressed reply arrives. Message/dependency cycles escalate.
- `failed`, `cancelled`, `needs_human -> ready` requires explicit operator retry after ownership/action reconciliation. Counters and approved limits are not reset. A new revision and approval are required to raise limits.
- `done` cannot be reopened by worker mail. A separately bounded read-only responder handles a late addressed question once per message set.

## Mail and decisions

One project mailbox, stable IDs and thread/reply references, task-scoped participants. Bearer capability plus bound session determines identity; no sender argument exists. Read/delivery and acknowledgement are separate. Retries with the same ID/body are deduplicated; changed bodies with reused IDs fail. Process each delivered message once and then acknowledge it. Mail is queued until a safe turn boundary.

Questions may go directly between tasks or to `operator`. A proposal is not an approval. An accepted proposal must reference a committed decision record. Any resulting interface/acceptance/policy changes require new task revisions and milestone approval before dependent work continues. No automatic permission approvals.

## Work and integration

Each implementation owns a branch/worktree from its explicit base. Named locks cover shared manifests/contracts; submission validates actual paths including both rename endpoints, deletions, and symlink/submodule boundaries. Dependency edits need explicit task approval. Ordinary tasks cannot edit harness/policy/baseline tests. Maintenance requires independent review.

The writer is stopped before fresh-checkout verification. Commands come from the approved policy, use executable/argument arrays, have explicit environment/cwd/timeouts/logs/artifacts, and consume configurable compiler/graphical capacity. Tests execute project code on the host: this is trusted-local execution, not sandbox isolation.

One integration intent records previous target, submitted commit and candidate. Approval also captures the committed operator baseline, including plan/policy commits made after the task's explicit base. Merge those approved heads into a detached candidate, rerun combined checks, record pass, then compare-and-swap the harness-owned branch. Restart recognizes already-created merge parents and already-advanced candidates. Failed checks never advance the target. The user's current checkout is preserved; promotion requires a recorded verified result, is explicit and fast-forward only, and never pushes.

## Recovery and guarantees

One canonical runtime under Git common-dir (`.git/harness` by default), explicitly passed to workers. SQLite WAL contains tasks/mail/evidence/actions. A tiny separate SQLite ownership registry serializes supervisor/maintenance acquisition transactionally; it contains no mailbox or task records. An expired lease cannot override process ownership. Linux PID start identity distinguishes reuse; unsupported/uncertain process identity pauses instead of guessing.

Dispatch intent and message ID are committed before HTTP. Timeout is uncertain, not rejection. Session history/parent IDs and status reconcile accepted turns; lost/duplicate events never determine completion. Missing ambiguous history pauses. A recorded interrupted external command is marked uncertain and never blindly rerun. Inspect output and record operator reconciliation first. Arbitrary external commands are **not exactly-once**.

Pause stops new dispatch/verification/integration after already-started operations; running turns can reach safe boundaries. Drain finishes current turns/checks and exits without another prompt. Stop aborts owned sessions/process groups, preserves checkouts and exits. Explicit resume is needed. Uncertain processes are reported for operator reconciliation rather than reassigned.

The supervisor uses compiled, eagerly loaded modules and records their content identity. Source edits are not hot-reloaded. Stop all owned processes before rebuilding/restarting a different revision. Online backups use SQLite's backup API, not copying only the active database file.
