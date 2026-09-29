# Bootstrap acceptance audit

The harness and neutral starter are implemented. This is a **trusted-local, single-machine v1**; the evidence below distinguishes actual tests from unverified deployment/LLM behavior. Runtime state is SQLite-backed. The example starter-proof milestone is a versioned draft requiring explicit operator approval.

## Capability status

| Status | Capability | Evidence | Exact reproduction |
|---|---|---|---|
| **Implemented and tested** | Strict schemas; immutable revisions/approvals; dependency validation; lifecycle; leases; ownership fences; budgets/backoff; useful continuation; pause/drain/stop | `tools/harness/test/{foundation,engine,recovery}.test.ts`; 37 offline tests passed, including with global/system Git config disabled | `npm run test:harness` |
| **Implemented and tested** | Durable two-way mail, idle wake, busy-session exclusion, acknowledgement/deduplication, waiting-slot release, cycle detection, late read-only responder | Offline engine/recovery tests; actual live question/answer evidence in `live-smoke.md` | `npm run test:harness`; `npm run harness -- demo --repo /tmp/new-live-proof --mode live` |
| **Implemented and tested** | Authenticated scoped API; sender/session authorization; protected paths; dependency/contract gates; command-ID checks; paginated redacted evidence | `test/engine.test.ts`, `test/recovery.test.ts`, `test/adapter.test.ts`; real live `harness_check` calls | `npm run test:harness` |
| **Implemented and tested** | Independent fresh-checkout verification; candidate-tampering rejection; shared build/verification/graphical slots; serialized integration; restart reconciliation; explicit verified fast-forward promotion across milestones | Real Git/SQLite/subprocess tests, including individually passing but jointly failing changes and committed plan baselines | `npm run test:harness` |
| **Implemented and tested** | SQLite migrations through v3, WAL-safe online backup/restore, revision-scoped attempt history, repository binding, path/rename/deletion/symlink cases, subprocess errors/timeouts | `test/engine.test.ts`, `test/recovery.test.ts` | `npm run test:harness` |
| **Implemented and tested** | OpenCode 1.18.33 SDK adapter: owned authenticated loopback servers, directory/session checks, async IDs/history, permissions, continuation, shutdown | `live-smoke.md`; no-spend API probe; actual permission/reject/resumption probe | `node tools/harness/scripts/probe.mjs .local/api-probe`; `node tools/harness/scripts/permission-probe.mjs` |
| **Implemented and tested** | Repo-local custom tools load in a fresh worktree without application/harness checkout dependencies | `.git/harness/worktree-api-probe.json`; zero model calls, all scoped tool IDs present, owned server stopped | `node tools/harness/scripts/worktree-probe.mjs .` |
| **Implemented and tested** | Standalone package installation, both templates/schemas/lockfiles, generic workflow with no Rust/GPU/model requirement | `/tmp/opencode/harness-package-proof-v13wlV/proof.json`; clean committed-release live workflow and explicit disposable promotion in `live-smoke.md` | `npm --prefix tools/harness run test:package`; `npm pack ./tools/harness` |
| **Implemented and tested** | Rust 1.95.0 / Bevy 0.19.1 template generation; renderer-independent shared core; headless CLI/input validation/replay; protected baseline | Four Rust tests; `artifacts/replay/replay.json`; `cargo tree` shows no Bevy/window/audio/render dependency in headless | `cargo test --locked`; `cargo clippy --locked -p project_core -p headless --all-targets -- -D warnings`; `node scripts/replay.mjs` |
| **Implemented and tested** | Desktop build/lint, finite render/screenshot smoke, shared core digest comparison | `artifacts/desktop/smoke.json`; screenshot `artifacts/desktop/frame-d1b62d78-67e2-417a-b03d-ea74b5d152b8.png` inspected; RTX 4080 SUPER/Vulkan | `cargo build --locked -p desktop`; `cargo clippy --locked -p desktop --all-targets -- -D warnings`; `node scripts/desktop-smoke.mjs` |
| **Implemented and tested** | Generic launcher hook preserves argument boundaries and profile environment substitution | Harmless real launcher subprocess in recovery tests | `npm run test:harness` |
| **Implemented and tested** | Bounded planner draft generation within project-specific limits | Post-bootstrap planner fix: 41 offline tests pass; live planning produced `.harness/plans/proposed-proof.yaml` with `steps: 12`. Session/action and shutdown evidence are in `progress.md` | `npm run test:harness`; for a fresh live draft use `npm run harness -- plan --repo . --brief docs/briefs/starter-proof.md --out .harness/plans/planner-check.yaml` with a new output path |
| **Implemented but unverified live** | Reviewer model behavior and semantic judgment | Production bounded read-only reviewer implemented; fake-adapter reviewer tests pass. No claim that live semantic judgment was validated | Configure `integration.reviewRole: reviewer` in a newly approved policy for semantic gates |
| **Implemented but unverified live** | Supervisor crash fault injection against real OpenCode/provider; interactive convenience-command execution after reload | Offline recovery faults pass; actual live probes cover normal resumption and API/permission shapes. Commands/config pass installed config loading | Restart OpenCode, then `/harness-status`; use the runbook's controlled stop/restart workflow before fault injection |
| **Implemented but unverified remotely** | CI definitions and non-Linux host behavior | `.github/workflows/checks.yml` exists; no remote repository/push/CI run was created. Linux is the tested process-ownership platform | Run the workflow in an operator-controlled CI environment; repeat compatibility and offline tests on another OS |
| **Blocked by unavailable telemetry** | A known monetary total/hard billing cap for the configured provider | SDK monetary price was unavailable, reported **unknown**. In-flight token overage was observed and documented | Inspect `status` consumption/overages and `live-smoke.md`; provider-side billing controls are outside v1 |
| **Deliberately deferred / out of scope** | Distributed orchestration, dashboard, mandatory MCP, agent marketplace, remote push, publishing, game content, OS/container isolation, automatic runtime relocation | Excluded by the requested v1 scope. Launcher hook is not an isolation claim; repository binding rejects accidental cross-repository state reuse | No command claims these capabilities |

## Required acceptance cases

1. **Useful continuation:** an unfinished worker turn receives a concrete revision/criteria/mail/evidence/limits instruction. A final “done” message does not complete the task. Both fake and live alpha workers required continuation.
2. **Active two-way mail:** question/answer delivery and acknowledgement are separate; busy sessions have one in-flight prompt; a waiting worker releases a one-slot scheduler so its responder can run.
3. **Restart durability:** active task, pending mail and dispatch identity survive a new supervisor instance. A real recorded external process is terminated/reconciled and not blindly relaunched.
4. **Uncertainty/cancellation:** ambiguous acceptance pauses unless history proves the ID; expired leases retain/reconcile ownership; lost event streams fall back to polling. Uncertain cancellation reserves capacity and prevents a replacement writer. Late verification results cannot resurrect cancelled work.
5. **Independent completion authority:** incomplete submissions fail real subprocess checks. Workers cannot set done, call operator administration, change an imported revision in place, spoof a sender/session, edit protected policy, or supply arbitrary verifier commands.
6. **Integration:** two individually passing changes that fail together do not advance the integration branch. A crash after Git advancement reconciles the recorded verified candidate. Plan/policy commits captured by approval remain ancestors of the combined result, making explicit promotion work across successive milestones.
7. **Finite execution:** prompt/attempt/elapsed/step/no-progress/provider retry limits are finite. Pending permissions are explicit blockers. Internal OpenCode retry notifications are bounded; no competing continuation loop or provider fallback is introduced.
8. **Portability:** `npm pack`/offline install/standalone generic demo run from a separate temporary repository. The engine has no application imports and its tests do not execute Cargo or require a GPU/model.

## Current evidence and limitations

- Headless and desktop state digest for seed 42, 120 ticks and `experiments/example.json`: `a0e4a7d818ae130b1c9130a8c8d1635c5358ebd7f155c41853abf61084b247c9`.
- Final live/package/application evidence was collected from committed revision `f602de4de94c26bea29e24c3adc007b327d5a0f2`. Packaged live result: `/tmp/opencode/harness-release-final-proof/.git/harness/demo-report.json`, passed with all owned processes stopped. A local distributable is `.local/local-first-dev-harness-0.1.0.tgz`.
- This repository's runtime is stopped with `starter-proof@1` imported as an **unapproved draft**, zero attempts/prompts/workers and no pending mail/unresolved actions. A WAL-safe backup is `.local/bootstrap-state.sqlite`. Runtime status remains authoritative via the CLI, not this historical audit snapshot.
- Commands/templates use exact direct dependency versions and committed npm/Cargo lockfiles. The Node runtime is pinned to 24.21.0; the locally installed archive checksum and source URLs are in `preflight.md`.
- Ordinary execution is trusted-local. Approved checks execute project code. Worktrees and OpenCode permissions are not an OS sandbox. Process groups and Linux PID start identities are tracked, but arbitrary self-detaching programs/custom launchers need their own tested lifecycle/isolation contract.
- Prompts have durable intent/message identities; ambiguous outcomes pause. Mail/check request IDs are deduplicated in the supported workflow. Arbitrary external commands are not exactly-once.
- Consumption is observation-based: implementation turns and bounded read-only roles are reported separately, with unknown/incomplete states and known lower bounds. In-flight activity can exceed the prior observed allowance. Monetary estimates are not provider-side caps.
- Schema/authorization/verification modules are compiled once; worker tool code is snapshotted from the installed release. Upgrading during a run requires stop/restart. Build records include source revision/dirty state and lock digest; release records include compiled/tool content hashes.
- Completed and failed worktrees/evidence are retained for inspection. No supervisor is installed as a background service. All owned processes used by the recorded smoke/probe runs were stopped; the user's bootstrap session was not commandeered.

## Operator entry points

```sh
export PATH="$PWD/.local/node-v24.21.0-linux-x64/bin:$PATH"
npm --prefix tools/harness ci
npm run build:harness
npm run harness -- task import --repo . --file .harness/plans/starter-proof.yaml
npm run harness -- approve --repo . --milestone starter-proof
npm run harness -- resume --repo .
npm run harness -- run --repo . --max-ms 1800000
# In another terminal:
npm run harness -- status --repo .
npm run harness -- mail --repo . --recipient operator
npm run harness -- answer --repo . --question MESSAGE_ID --body 'Your reviewed answer'
npm run harness -- checkpoint --repo . --task starter-proof
npm run harness -- stop --repo .
```

For package reuse, checks, promotion and recovery, follow `docs/runbook.md`. Quit and restart OpenCode to load the repo-local agents, scoped tools and convenience commands.
