# Operator runbook

## 1. Install and inspect

```sh
# This checkout's optional, ignored local Node distribution:
export PATH="$PWD/.local/node-v24.21.0-linux-x64/bin:$PATH"
npm --prefix tools/harness ci
npm run build:harness
npm run harness -- doctor --repo .
npm run harness -- status --repo .
```

All harness commands take an explicit `--repo`. `--runtime` may choose an external canonical location on first use; the Git common-dir marker then rejects a different location, including from linked worktrees. Default: `<git-common-dir>/harness`. No mailbox/database is created inside each worker checkout. Preserve this directory and the Git objects/worktrees when moving a project.

`tools/harness/` can be built/installed independently. Node/npm/Git are the generic prerequisites; OpenCode 1.18.33 and existing provider access are needed only for live work. The configured model wins; otherwise the existing OpenCode recent selection is validated. Per-role `model: provider/model-id` overrides are explicit. An unavailable selection blocks without provider fallback. `doctor` is a no-spend prerequisite inspection, not a live authentication or rendering pass.

The root application uses stable Rust 1.95.0 and Bevy 0.19.1. Default Cargo members are headless-safe. Desktop requirements are checked separately. Local package installation never changes global OpenCode settings or Git identity.

## 2. Brief and draft

Write a brief with the desired outcome and exclusions. This repository already includes `.harness/plans/starter-proof.yaml`; to use that plan, proceed to section 3. Generating another plan is optional. To generate a **bounded live draft** from a new or revised brief:

```sh
npm run harness -- plan --repo . \
  --brief docs/briefs/starter-proof.md --out .harness/plans/proposed-proof.yaml
```

The planner has one read-only prompt, at most 10 steps/120 seconds (or lower configured limits), and no approval/integration tool. It receives a project-constrained schema: each proposed task's limit must be no greater than the corresponding value in `.harness/project.yaml`'s `defaults`. `steps` is the maximum agent iterations per prompt; `prompts` bounds the number of turns. Omitted limit fields use the configured project values. The returned draft is checked against that same schema and the task graph. Invalid proposals remain in runtime planning records, with diagnostics naming the field, requested value and allowed maximum. Existing output files are rejected before any model call. The command neither imports nor approves the plan. If live planning is unavailable, author a plan manually using `tools/harness/schemas/plan-v1.schema.json`; runtime Zod also validates normalized paths and graph/cross-field constraints.

The included `.harness/plans/starter-proof.yaml` is a small **unapproved example**: record proof for the existing neutral starter. It adds no product scope. Review the concrete `baseCommit`, task revisions, dependencies, editable paths, shared-lock keys, acceptance, command IDs, artifacts and limits before using it.

## 3. Commit, import and approve a milestone

**This Rust/Bevy starter is already configured.** `.harness/project.yaml` defines real formatting, linting, core tests, headless smoke/replay and separate desktop build/smoke commands. It also defines the worker roles and resource limits; you do not need to fill in or replace a placeholder check for this repository.

When initializing a different project with `generic-command`, replace that template's print-only example with checks that actually fail when the project's acceptance criteria are not met. Roles are instruction templates for planner, implementer, researcher and reviewer; this Rust profile also assigns core and presentation responsibilities. The scheduler uses those instructions and configured limits without requiring you to design its behavior yourself.

Commit the reviewed policy, plan and any decision record using your existing Git identity. Then:

```sh
npm run harness -- task import --repo . --file .harness/plans/starter-proof.yaml
npm run harness -- task list --repo .
npm run harness -- task show --repo . --id starter-proof
npm run harness -- approve --repo . --milestone starter-proof
```

Approval binds all included immutable revisions and finite limits in one operation. No per-continuation approval is needed. Default slots: 3 implementations, 1 verification, 1 graphical job, 2 build jobs. Default per-task limits: 3 attempts, 12 prompts, 12 agent steps/prompt, 30 minutes elapsed, 3 no-progress turns, 2 provider retries, 8 prompts/session, 200,000 observed tokens and $5 when observable. The task may choose lower explicit limits. Raising limits or changing scope/policy requires a new approved revision; counters are never silently reset.

## 4. Start and inspect

```sh
npm run harness -- resume --repo .
npm run harness -- run --repo . --max-ms 3600000
```

`run` stays in the foreground; use another terminal for inspection/control. The explicit wall-clock cap is 100 ms–24 hours, default one hour. `run` never implicitly resumes paused work. On exhaustion of approved tasks it stops; it does not invent another milestone.

```sh
npm run harness -- status --repo .
npm run harness -- logs --repo .
npm run harness -- mail --repo . --recipient operator
npm run harness -- checkpoint --repo . --task starter-proof
```

Status/logs are JSON with task/attempt/worker/session/state/blocker/next-action/evidence, consumption, limits and observed overages. For machine parsing use the standalone executable or `npm --silent run harness -- ...` to suppress npm's own banner. Redirect a status response to an ignored artifact if you need a snapshot; it is not an editable source of task authority.

The supervisor runs compiled modules from a recorded content hash. A worker's edits do not hot-reload the supervisor, policy or verifier. Stop all owned workers before a harness rebuild/upgrade and restart explicitly. Worktrees/branches start at recorded commits; dependency tasks use an explicit integrated base containing their completed dependencies. User checkout and branch are preserved.

## 5. Mail, operator answers and permissions

Workers use `harness_context`, `harness_evidence`, `harness_mail_send/read/ack`, `harness_checkpoint`, `harness_check`, `harness_block`, and `harness_submit`. Evidence IDs provide paginated redacted compiler/check logs without arbitrary runtime filesystem access. The local API derives identity from a scoped token and bound session. Worker tools cannot approve plans, set done, integrate, promote, or act as another sender. Direct worker-to-worker conversations are addressed and task-scoped. Waiting releases implementation capacity; delivery waits for a safe boundary if a recipient is busy. A completed task may get a one-turn, ≤60-second read-only responder for a late question.

```sh
npm run harness -- answer --repo . --question MESSAGE_ID --body 'Use the already approved interface.'
```

An ordinary answer wakes human-blocked work at a safe boundary, while pause still wins. For a proposal, first commit the authoritative decision record:

```sh
npm run harness -- answer --repo . --question PROPOSAL_ID \
  --body 'Accepted as recorded; revised tasks still need approval.' \
  --decision-record docs/decisions.md
```

Then import/approve the new task revision(s). Conversation alone cannot amend acceptance. Protected harness/policy/contracts/baseline tests need `kind: maintenance`, a committed decision record, and `integration.reviewRole: reviewer`. Dependency manifest/lock changes need explicit `allowDependencies: true`, a decision record, and the named manifest lock.

Permission requests are visible blockers, never auto-approved:

```sh
npm run harness -- permissions --repo . --worker WORKER_ID
npm run harness -- permission --repo . --worker WORKER_ID --request REQUEST_ID --reply reject
# After reviewing the exact request, use --reply once when appropriate.
```

There is no `always` option. Inspect the actual owned OpenCode session/request before approving. Destructive Git, credential access, publishing, purchases, global changes and privilege escalation are not automatically permitted. Approved builds/checks use `harness_check` with command IDs and stable request IDs; repeated reads do not relaunch an ambiguous action. They share the verifier's global build/graphical job limits. Direct compiler commands are denied in supervised shell permissions. An explicitly operator-approved arbitrary shell operation is trusted-local execution outside those command-level accounting guarantees.

## 6. Verification and integration

Submitting an immutable clean commit is not completion. Actual changed paths (including rename endpoints and deletions), shared contracts, dependencies, protected material, artifacts and symlink/submodule boundaries are validated. Ordinary v1 candidates with symlinks/submodules are conservatively rejected.

The writer is stopped; approved commands execute in a fresh candidate checkout. Commands have argument arrays, explicit cwd/environment, timeouts, exit capture and artifact paths. `envFrom` is an approved allowlist of environment names; default inheritance excludes provider/admin secrets. Compiler outputs, temp files and command artifacts are isolated per action. Output is bounded and redacted, including secrets split across pipe chunks. Completed command logs are under runtime `artifacts/<action>/output.log`; active action state remains observable while output is being collected.

Language-specific build environment belongs in the profile's `executionEnv`. The Rust profile maps `CARGO_TARGET_DIR: '{buildDir}'` and `CARGO_BUILD_JOBS: '{buildJobs}'`; the generic engine knows neither Cargo nor simulation concepts. Environment/argument placeholders are `{artifactDir}`, `{buildDir}`, `{buildJobs}`, `{tempDir}`, `{dataDir}`, `{workspace}`. Saves honoring XDG data/state directories use an isolated per-action location.

Semantic review, when configured, uses a separate bounded read-only session. Commands/reviewer may not silently alter the candidate, including by making another commit. Tests still execute project code on the host and are not a sandbox.

The serialized integration queue builds a candidate on the latest target, reruns task and combined checks, and compare-and-swaps `harness/integration` only on pass. A changed candidate requires new checks. Conflicts and failed checkouts remain available for inspection. Restart recognizes recorded merge parents and an already-advanced verified target.

Manual maintenance while the supervisor is stopped:

```sh
npm run harness -- verify --repo . --task TASK_ID
npm run harness -- integrate --repo . --task TASK_ID
```

Review all evidence/diffs before explicit user-branch promotion:

```sh
git diff main...harness/integration
npm run harness -- promote --repo . --target main
```

Promotion requires a clean user checkout on the named branch and is fast-forward only. No remote push command exists.

## 7. Pause, stop, restart and recovery

```sh
npm run harness -- pause --repo .                 # no new work; existing operations reach boundaries
npm run harness -- pause --repo . --milestone starter-proof
npm run harness -- drain --repo .                 # finish active turns/checks, do not dispatch another turn
npm run harness -- stop --repo .                  # abort owned sessions/process groups; preserve work
npm run harness -- resume --repo . --milestone starter-proof
npm run harness -- resume --repo .
npm run harness -- run --repo . --max-ms 3600000
```

Ctrl-C/SIGTERM requests controlled stop. No detached supervisor is silently installed. A crash may leave owned servers alive; their process/session records remain for reconciliation. Lease expiry alone never authorizes a replacement. On Linux, PID start identity is checked to avoid PID reuse. Uncertain/missing identity pauses; other OS ownership behavior is conservative and not claimed fully tested.

For a blocked owner/action, inspect status, Git diff, evidence and the recorded session history first:

```sh
npm run harness -- reconcile-worker --repo . --worker WORKER_ID --reason 'Inspected the recorded session and preserved checkout.'
npm run harness -- resolve-action --repo . --id ACTION_ID --reason 'Inspected output and confirmed the external outcome.'
npm run harness -- retry --repo . --task TASK_ID --reason 'Prior owner stopped and external action reconciled.'
```

The first command only succeeds on provable owned termination; it does not accept a lease timeout or a guessed PID as proof. If ownership remains uncertain, inspect the recorded private process metadata and terminate only that confirmed owned process before trying again. A startup crash before any PID identity was durable can need manual process investigation. Never delete ownership files merely because a session is quiet. For stopped workers, resumption uses the actual diff/spec/evidence/mail and preserves attempt/prompt consumption.

Prompts persist intent and message IDs before HTTP. Missing/duplicate SSE events are harmless notifications; history/status reconcile durable outcome. An ambiguous timeout with no provable result pauses rather than duplicating a prompt. Arbitrary external commands are **not exactly-once**. A tracked long build is not narration-only idle. Repeated unproductive turns, provider errors and pending permissions stop/block under finite limits.

Token/money limits apply to observed completed turns. In-flight turns, cache usage and OpenCode internal activity can overshoot the prior allowance; no further prompt is allowed after the observed limit. The packaged live smoke demonstrated such an in-flight token overage, exposed in status. Monetary prices can be **unknown**; estimates are not provider billing caps. See `docs/bootstrap/live-smoke.md`.

## 8. Backup and restore

```sh
npm run harness -- backup --repo . --file /absolute/new/location/state-backup.sqlite
```

This uses SQLite online backup and includes committed WAL state. Do not copy only an active `state.sqlite` file. A database backup alone does not contain Git objects, uncommitted worktrees, logs, server metadata or large artifacts; preserve those alongside it for full recovery.

Restore procedure: controlled stop; verify recorded owned processes stopped; archive the entire canonical runtime (including main DB/WAL/SHM) and repository/worktrees; leave the destination `state.sqlite` absent; then:

```sh
npm run harness -- restore --repo . --file /absolute/location/state-backup.sqlite
npm run harness -- status --repo .
# Reconcile recorded owners/external actions and only then resume/run.
```

Restore acquires exclusive ownership, checks backup integrity/schema/repository binding, rejects an existing destination, and atomically installs the checked database. Runtime directories cannot be shared accidentally between different Git repositories. Cross-repository restore or relocating absolute runtime/worktree paths requires an explicit offline migration; it is not automatic in v1. Legacy unbound backups must be inspected/migrated in their original stopped repository before using the bound restore path. The separate ownership registry is not restored as an active owner. Migration/backup/restore behavior is exercised in offline tests.

## 9. Checks, samples and portability

```sh
npm run test:harness
npm --prefix tools/harness run test:package
npm run harness -- demo --repo /tmp/new-harness-mock --mode mock
npm run harness -- demo --repo /tmp/new-harness-live --mode live
cargo fmt --all --check
cargo clippy --locked -p project_core -p headless --all-targets -- -D warnings
cargo test --locked
node scripts/replay.mjs
cargo build --locked -p desktop
node scripts/desktop-smoke.mjs
cargo run --locked -p desktop
cargo run --locked -p headless -- --seed 42 --ticks 120 --input experiments/example.json --output artifacts/result.json
```

Demo paths must be new/empty. Both demos use production state/scheduler/mail/Git/verification/integration; only the mock worker runtime is replaced. Live demo is bounded, uses existing credentials, and exits unverified (code 2) when it cannot establish a real pass. Final reports live in the disposable repo's `.git/harness/demo-report.json`. Owned processes stop on exit.

Standalone reuse:

```sh
npm pack ./tools/harness
# In another repository with a local npm package.json:
npm install --save-dev /absolute/path/to/local-first-dev-harness-0.1.0.tgz
npx --no-install harness init --repo /absolute/path/to/target --profile generic-command
npx --no-install harness doctor --repo /absolute/path/to/target
```

The package ships both templates, JSON schemas and an npm shrinkwrap for transitive pinning. Packaging proof installs it into another temporary npm repository **offline from the populated npm cache** and runs a generic workflow without Rust/model/GPU. `init` refuses conflicting existing files rather than overwriting them; merge desired configuration manually in an established project.

The optional policy `sandbox: { executable: "your-launcher", args: [...] }` wraps owned servers and commands using argument arrays. Supply/test the actual launcher for your environment. V1 itself provides no container isolation. Linux host execution is the tested platform. CI definitions contain offline harness and headless Rust gates without model secrets; their existence is not evidence a remote CI run occurred.
