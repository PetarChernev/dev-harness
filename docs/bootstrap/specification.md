# Bootstrap a reusable OpenCode development harness

You are working in an initially empty repository. Implement a small, working, reusable development-orchestration harness, then initialize a neutral Rust/Bevy project using it. This is an implementation request, not a request for an architecture proposal alone.

The harness must support long-horizon execution across replaceable OpenCode sessions, parallel workers, persistent two-way communication, independent verification, and serialized integration. It must be reusable for projects unrelated to games and for languages other than Rust. Rust/Bevy is the first project template, not part of the scheduler's domain model.

Do not invent a game, gameplay systems, content, or a visual identity. Use a neutral sample to exercise the toolchain.

## 1. Scope and implementation choices

Build a local-first, single-machine v1. Use TypeScript, a pinned supported Node.js LTS runtime, npm, SQLite, and the official OpenCode JS/TS SDK. Choose a small maintained SQLite driver compatible with the selected runtime. Use strict typing, schema validation at boundaries, and a conventional test runner. Pin dependency versions and commit lockfiles.

Put the independently packageable harness in `tools/harness/`. It must expose a CLI and accept an explicit target repository path. It must not depend on the application workspace, import application code, or require Cargo, Bevy, a GPU, OpenCode, or model credentials for its own offline tests.

Separate three concerns:

- **Harness engine:** tasks, scheduling, leases, messages, evidence, budgets, workspaces, and integration.
- **Worker runtime adapter:** OpenCode session/process control, plus a deterministic fake adapter for tests.
- **Project profile/template:** repository layout, role instructions, build/test commands, artifact requirements, and project-specific policies.

Provide two profiles: `generic-command`, requiring only configured executable commands, and `rust-bevy`. Package the templates with the harness; do not reference absolute paths in this bootstrap checkout.

Do not add Kubernetes, Redis, Temporal, LangGraph, a web dashboard, mandatory MCP services, an agent marketplace, or multiple competing continuation mechanisms. Do not build a new coding-agent runtime. Do not require publishing a package or creating a remote repository.

The coordinator is an LLM role that proposes plans and resolves ambiguity. Scheduling, authorization, state transitions, verification, budgets, and merge operations are ordinary program logic, not decisions delegated to a perpetually chatting coordinator.

## 2. Preflight before implementation

Inspect the actual environment: OS, Git, Node/npm, OpenCode, available provider/model configuration, Rust/Cargo, and desktop build prerequisites. Do not print secrets. Do not assume a particular model, provider, platform, or globally installed tool.

Read the current official OpenCode SDK, server, agents, custom-tools, configuration, and permissions documentation. Inspect the installed OpenCode version, its published API specification, and the installed SDK types before implementing the adapter. Validate compatibility with a small probe. Do not invent methods or copy an outdated example uncritically.

For Bevy, select a compatible stable Bevy/Rust pair using current official documentation and crate metadata. Record concrete versions in the manifests, toolchain file, lockfiles, and compatibility notes. Do not use unpinned `latest`, wildcard dependencies, or nightly-only optimizations by default.

Record findings, source locations, chosen versions, and unresolved prerequisites in `docs/bootstrap/preflight.md`. Missing Rust or graphical prerequisites must not block the generic harness and mock tests. Missing credentials must not block offline development.

Use local project configuration. Do not overwrite global OpenCode settings, change global Git identity, install global packages, use administrator privileges, purchase services, or change account settings. Ask only for a genuinely required permission or non-resolvable choice. Otherwise make a reversible choice and record it.

Initialize Git when necessary. Local commits for this bootstrap are authorized; remote pushes are not. If commit identity is absent, explain the precise blocker without fabricating an identity. Never overwrite unexpected existing files.

## 3. Durable project knowledge and configuration

First save this specification under `docs/bootstrap/` and create `docs/bootstrap/progress.md` with phases, acceptance criteria, evidence, blockers, and the next concrete action. Update it after meaningful progress so another session can resume the bootstrap.

Create a short root `AGENTS.md` that points to authoritative documents rather than duplicating all of them. Provide architecture, operating-protocol, decision-record, and operator-runbook documents. Explain ownership, escalation, task completion, integration, and recovery.

Use `.harness/project.yaml` for versioned project configuration. Support configurable roles, model mappings, resource limits, command definitions, integration targets, protected paths, and named shared-resource locks. Validate it against a versioned schema.

Keep approved task specifications and plans as versioned YAML/JSON. Import immutable revisions into SQLite; runtime task status belongs in SQLite. An export is a snapshot, not a competing editable authority. Reject silent changes to approved acceptance criteria; a new specification revision requires approval and invalidates obsolete verification.

Keep databases, process metadata, credentials, worktrees, logs, and large artifacts out of version control. Resolve one canonical runtime directory per repository, outside worker checkouts, and pass its location explicitly. Do not create an independent mailbox or task database inside every worktree.

Build the supervisor from a known harness revision. Worker edits must not hot-reload the supervisor, its authorization rules, or its verifier. Upgrading the harness during a run requires a controlled stop and restart.

## 4. Task model and scheduler

Implement a persisted task lifecycle with explicit transitions:

`draft → ready → running → submitted → verifying → integration → done`

Also support `blocked`, `needs_human`, `failed`, and `cancelled`, including documented retry transitions. A final assistant message is not evidence of completion. A worker may submit work, but cannot set its own task to `done`.

A task specification must include its ID/revision, milestone, objective, dependencies, role, editable paths, shared-resource lock keys, acceptance criteria, verification command IDs, required artifacts, and execution limits. Runtime records must retain attempts, worker/session identities, leases, base/submission commits, checkpoints, pending questions, evidence, and consumption.

Model task outputs explicitly. A code task needs an immutable change set; a research task may produce a report and reproducible experiment without changing application code. Define completion requirements for both.

Only schedule approved work with satisfied dependencies and available resources. Approving a milestone approves its included task revisions and limits in one operation; do not request approval for each routine continuation or newly unblocked dependency. Material scope or policy changes require a new approval. Reject cyclic dependencies. Use transactions, uniqueness constraints, atomic claims, and a single-supervisor lock. Add schema migrations and a tested backup/restore procedure; do not back up an active database by naively copying only its main file.

Use renewable task leases and worker/process ownership records. A lease expiry alone is not proof that the old worker stopped: reconcile or terminate the previous process before reassigning its work. Uncertain ownership must pause that task rather than create two writers.

Default to three implementation slots, one verification slot, and one slot for expensive graphical jobs. Make all limits configurable. Workers blocked on messages must release scheduling capacity. Detect unresolved dependency/message cycles and surface them rather than consuming tokens indefinitely.

Use named exclusive locks for shared contracts/manifests rather than trying to infer every possible overlap between arbitrary file globs. Also verify actual changed paths at submission.

## 5. OpenCode adapter and long-horizon continuation

Implement the OpenCode adapter behind a small typed interface covering session creation/resumption, prompt dispatch, status, message inspection, event observation, cancellation, and health checks. The fake adapter must exercise the same scheduler-facing contract.

For v1, use a separately owned OpenCode server process per active worker checkout, with its working directory explicitly set. Bind to loopback, configure authentication, allocate non-conflicting ports, and verify the server's reported directory before dispatching work. Never commandeer the user's bootstrap session.

Use the existing configured model by default, allow validated per-role overrides, and never silently switch providers. Inspect any configured agent iteration limits rather than assuming every early stop is a failure.

Use the supported server/SDK APIs, not terminal scraping or simulated keystrokes. Treat events as notifications; reconcile durable state with session status and message history after restart or stream loss. Test the actual installed API shapes, including error handling, permissions, asynchronous prompting, and session scoping.

Allow at most one in-flight prompt per session. Persist dispatch intent and request/message identities. An HTTP timeout does not establish that a request was rejected: inspect session history before retrying. When an outcome cannot be established safely, record it as uncertain and pause rather than blindly duplicating the action.

When a worker finishes a turn, inspect its structured result and task state. If approved work remains, send a concrete next instruction containing the current task revision, remaining acceptance criteria, relevant messages, latest evidence, and limits. Do not merely send the word `continue`.

Recognize submission, recoverable failure, blocked-on-agent, pending permission, human decision, budget exhaustion, and actual completion as distinct situations. Never automatically approve a permission request merely because it blocks progress.

Create new sessions when context becomes unhelpful or a session cannot be resumed. Rehydrate them from the task, approved decisions, current checkout, recent evidence, and unresolved messages. Require inspection of the current diff and relevant checks; a handoff summary is not proof.

Track meaningful progress using changed artifacts, completed checks, resolved dependencies, and new evidence. Repeated narration is not progress. A tracked long-running build or experiment is not idle merely because it produces no recent text. After a configurable number of unproductive attempts, escalate or fail the task. Bound retries with backoff and avoid retry storms after provider errors.

Implement explicit pause, resume, drain, and stop behavior. Track subprocesses and preserve unfinished work. A paused milestone must not restart itself because a worker becomes idle. Do not promise exactly-once execution of arbitrary external commands; document the reconciliation and deduplication guarantees actually implemented.

## 6. Persistent two-way communication

Implement a small durable mailbox in the same project state service. Do not make an external messaging plugin mandatory for v1.

Messages need stable IDs, thread IDs, sender/recipient identities, associated task IDs, timestamps, type, body, reply references, delivery state, and acknowledgement state. Support questions, answers, proposals, accepted-decision notifications, blockers, and evidence notifications.

Expose narrowly scoped OpenCode custom tools for reading task context, sending/reading/acknowledging messages, recording checkpoints, submitting results, and declaring blockers. Tools call an authenticated local control API. Route state mutations through one validated service API; CLI maintenance while the supervisor is stopped must acquire exclusive ownership. Workers must not edit SQLite directly or receive supervisor-administration credentials. Derive sender identity from the worker/session authorization context, not an agent-supplied name.

Messages must actually reach working agents. Wake an idle recipient; queue delivery until a safe boundary for a busy recipient. Preserve message IDs across retries. Distinguish delivery from acknowledgement and suppress duplicate processing in the supported workflow. Do not inject competing prompts into a busy session.

Allow direct worker-to-worker discussion without forcing the coordinator to relay every message. Keep conversations addressed and task-scoped, not globally broadcast. Ensure a waiting worker does not occupy the only slot capable of running the responder. Provide a bounded read-only responder session when answering a late question should not reopen completed implementation work.

A conversation does not amend the specification. Shared-interface or acceptance changes must follow an explicit proposal/approval flow and update the authoritative decision record before dependent work continues.

Provide configurable role templates for planner, implementer, researcher, and reviewer. Roles are persistent responsibilities; sessions are replaceable. The Rust/Bevy profile may specialize implementers into core and presentation responsibilities without adding those concepts to the scheduler.

Supervised workers must not spawn unmanaged agent trees. All persistent parallel work must pass through the harness so its messages, scope, and resource use remain visible.

## 7. Workspaces, verification, and integration

Give every implementation task its own Git worktree and branch from an explicit base commit. Preserve the user's main checkout. Give workers separate temporary files, saves, build outputs, and service ports where necessary. Use a configurable global build-job limit to avoid parallel compilers exhausting memory.

Submission must identify an immutable commit/change set, the task revision, declared changes, evidence, and remaining limitations. Check for dirty files, unexpected paths, missing artifacts, unapproved contract changes, and altered verification policy. Include renames, deletions, and path traversal/symlink cases in boundary checks.

Verification runs independently in a fresh candidate checkout using command definitions from the approved policy snapshot. Do not execute arbitrary verifier commands supplied by the submitting agent. Run processes with explicit executable/argument arrays, working directory, environment, timeout, exit-code capture, and artifact paths; avoid concatenating untrusted shell strings.

Use deterministic checks first, then a separate reviewer session for semantic review where configured. The reviewer reports findings and cannot approve its own implementation or silently edit the candidate. A failed check goes back to the owner with reproducible evidence; changing the criteria to hide a failure is not a repair.

Protect the harness, permission policies, shared contracts, and baseline acceptance tests from ordinary application tasks. Changes to protected material require an explicitly approved maintenance task and independent review. Recognize that approved project test commands still execute project code; they are not inherently safe sandboxes.

Use one serialized integration queue. Apply a submitted change to the latest integration candidate, rerun the required combined checks, and only then advance the integration branch. Record the verified candidate and resulting commit. A pass against an old base is not sufficient for a changed integration candidate.

Make integration restart-safe: reconcile recorded attempts with Git before retrying. Do not duplicate a merge/cherry-pick or move the target branch after a failed check. Preserve conflict evidence and return conflicts for resolution. Default to a harness-owned integration branch; promotion to the user's main branch is explicit, and remote push is disabled.

## 8. Permissions, limits, and observability

Use project-scoped, role-specific OpenCode permissions. Verify the effective merged configuration; do not assume a project file erased broader inherited permissions or disabled existing plugins. Do not enable blanket auto-approval. Keep approval-required requests visible as blocked work.

Never automatically approve destructive Git operations, credential access, external publishing, purchases, global configuration changes, or privilege escalation. Require review for new dependencies outside the approved bootstrap dependency set. Keep worker-control capabilities separate from operator approval and integration capabilities.

Worktrees, edit scopes, and tool permissions are not OS security boundaries. Label ordinary host execution as trusted-local mode. Provide a configurable sandbox launcher hook, but do not claim container isolation without actually implementing and testing it. Do not mount or copy unnecessary secrets into worker environments, and redact credentials from logs and prompts.

Implement caps for concurrency, attempts, elapsed time, prompts/steps where measurable, and resource-heavy jobs. Report token and monetary usage when available, with an explicit unknown state when not available. Estimated spend is not a hard provider-side billing cap; document in-flight usage and enforcement limitations.

Use finite defaults, expose them before a live run, and make raising them an operator action. User willingness to spend heavily is not permission for an unbounded retry loop.

Produce structured logs and status output showing task, attempt, worker, session, state, blocker, next action, and evidence. Record the reason for every scheduling, approval, retry, and integration decision. Provide a useful operator summary rather than requiring transcript inspection.

## 9. Rust/Bevy starter profile

After the generic harness works, initialize the root application from the `rust-bevy` template. Keep the generated application independent from the harness package.

Use a small Cargo workspace with a renderer-independent `project_core` crate, a `desktop` application, and a `headless` executable. Both executables must exercise the same core behavior, not separate implementations. Bevy ECS/App dependencies are acceptable in the core; rendering, window creation, and audio dependencies are not.

Use explicit compatible Bevy versions/features across crates. Make the headless build and checks genuinely usable without desktop system libraries or GPU access. Avoid a default workspace command that accidentally pulls in renderer features. Keep graphical build/smoke gates separate and visible.

Implement only a neutral demonstration: seeded moving entities, a small command/state interface, and a desktop visualization using simple generated geometry. No game content or externally licensed asset collection is needed.

The headless executable must accept a seed, explicit tick count, input/config file, and output location. Drive the simulation with controlled time/ticks, not elapsed wall time. Emit machine-readable results and a stable state digest. Test reproducibility for the same pinned build, configuration, seed, and inputs; do not claim cross-platform bitwise determinism without demonstrating it.

Provide a generic experiment artifact convention: hypothesis, code revision, configuration hash, seeds/inputs, command, environment, results, and limitations. Include a tiny example experiment. The harness only schedules commands and collects artifacts; it must not encode notions such as damage, waves, game balance, or win rate.

Configure formatting, linting, core tests, headless smoke/replay, and a separate desktop build/smoke command. Give graphical smoke tests a finite exit condition. Preserve screenshots when supported; when display/GPU prerequisites are unavailable, report that check as unverified or explicitly skipped by policy, never passed.

## 10. CLI and operator workflow

Provide a root `npm run harness -- ...` wrapper for this repository and a standalone packaged `harness` executable for other repositories. These are commands to implement, not existing OpenCode commands.

The CLI must cover initialization, profile-aware doctor checks, task import/list/show, plan generation, milestone approval, run/status/logs, mailbox access, checkpoint inspection, pause/resume/stop, verification, integration, and mock/live demos. Keep the command surface small and consistent; all important commands need help, clear exit codes, and machine-readable output.

A plan command should invoke the planner on a supplied brief and produce a schema-valid draft dependency graph for review. It must not approve itself or begin unlimited development. Permit manual task import without an LLM. When a milestone finishes, stop or await another approved milestone rather than inventing more product scope.

Support an authenticated operator answer/approval path for blocked decisions. Do not give worker tools that authority.

Create repo-local OpenCode agent/tool configuration and convenience commands for harness status, planning, and bootstrap resumption using the verified current OpenCode format. They must call or inspect the real harness rather than maintain a second text-only task list. Mark commands that require restarting/reloading the OpenCode session after installation.

Document a complete daily workflow: write a brief, generate/edit a plan, approve its limits, start the supervisor, inspect progress, answer questions, review evidence, promote an integrated result, and stop/restart safely.

## 11. Required acceptance tests

Build the fake-adapter tests first. They must run without model credentials, API spending, Rust, or a GPU. Use real temporary Git repositories, real SQLite, and actual harmless subprocesses where those boundaries matter; do not mock away the behavior being tested.

At minimum, prove the following:

1. A worker stops with approved work unfinished, and the supervisor resumes useful work without human `continue` messages.
2. Two workers exchange a question and answer while tasks are active; an idle recipient wakes, a busy recipient is not double-prompted, and a blocked worker releases capacity.
3. The supervisor restarts with an active task, pending mail, and a recorded external action. Recovery preserves state and does not blindly duplicate that action.
4. Duplicate or lost notifications, ambiguous prompt timeouts, expired leases, and cancellation do not create concurrent owners or falsely mark tasks complete.
5. An incomplete submission fails independent verification. A worker cannot promote itself, change approved criteria, spoof another sender, or silently edit protected policy.
6. Two changes that pass independently but fail together are rejected by the integration queue. Restarting an interrupted integration reconciles the existing Git result.
7. Budget exhaustion, unavailable providers, pending permissions, and repeated no-progress attempts stop or block cleanly without a tight loop.
8. Packaging and installing the harness into another temporary repository works with the generic profile, without application imports or Rust-specific assumptions.

Add tests for migrations, backup/restore, task graph validation, path handling, command execution errors, and CLI help/output. Mock mode must use the production scheduler/state/mail/integration code, replacing the worker runtime rather than replacing the whole workflow.

Add a small live OpenCode smoke demo using existing configured credentials only. It must involve at least two sessions, actual two-way mail, continuation, and independent verification on disposable non-critical tasks. Set explicit limits, collect evidence, and stop owned processes afterward. With missing credentials or permissions, leave the live demo runnable and label it unverified; never present a mock run as live validation.

Provide CI definitions that run offline harness tests and appropriate Rust checks without model secrets. Do not create a remote repository or assume CI has run merely because a workflow file exists.

## 12. Execution sequence and completion

Work in bounded phases, verifying and committing meaningful increments:

**Phase A:** preflight, saved specification, architecture decisions, schemas, CLI skeleton, and fake adapter.

**Phase B:** real persistence, scheduling, mailbox, continuation, worktrees, verification, and integration with passing offline recovery tests.

**Phase C:** real OpenCode adapter, custom tools, permissions, and the bounded live smoke demo where the environment permits.

**Phase D:** portable packaging, generic-profile proof, Rust/Bevy template, application smoke checks, runbook, and final audit.

Do not use the unfinished harness to rewrite or supervise its own running core. Prove it on disposable tasks before dogfooding application work. Do not stop after creating documents, interfaces, or mocks while describing the runtime as implemented. If a requirement is truly blocked, record the exact reason and continue independent work.

At the end, provide actual commands for starting a milestone, inspecting status, answering a question, running checks, starting the sample application, using the headless runner, and reusing the harness in another repository. Include a table distinguishing implemented-and-tested, implemented-but-unverified, blocked, and deliberately deferred capabilities, with evidence paths and exact reproduction commands.

Leave no unexpected background processes. Preserve unfinished work and explain any owned process intentionally left running. Do not claim full production hardening or security isolation beyond what was tested.

Start now with preflight and the smallest executable increment. Continue through the phases while authorized work remains; request human input only for a genuine blocker or approval boundary.

## Official references to verify during preflight

- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenCode server/API: <https://opencode.ai/docs/server/>
- OpenCode agents: <https://opencode.ai/docs/agents/>
- OpenCode custom tools: <https://opencode.ai/docs/custom-tools/>
- OpenCode configuration: <https://opencode.ai/docs/config/>
- OpenCode permissions: <https://opencode.ai/docs/permissions/>
- OpenCode commands: <https://opencode.ai/docs/commands/>
- Git worktrees: <https://git-scm.com/docs/git-worktree>
- Bevy setup: <https://bevy.org/learn/quick-start/getting-started/setup/>
- Bevy API documentation: <https://docs.rs/bevy/>
- Node.js release support: <https://nodejs.org/en/about/previous-releases>
