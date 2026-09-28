# Local development harness

An independently packageable TypeScript/SQLite supervisor for trusted-local projects. Requires Node **24.21.0** and Git. The engine has no application imports. Offline tests and the generic profile need no Rust, GPU, OpenCode executable or model credentials. The optional live adapter uses the official SDK with OpenCode **1.18.33**, owned loopback servers and explicit per-session permissions.

```sh
npm ci
npm run build
npm test
npm run test:package
npm pack
```

Install the resulting tarball locally (no publishing or global install required):

```sh
npm install --save-dev /absolute/path/to/local-first-dev-harness-0.1.0.tgz
npx --no-install harness init --repo /absolute/path/to/repository --profile generic-command
npx --no-install harness doctor --repo /absolute/path/to/repository
npx --no-install harness --help
```

Replace the example generic check with real executable/argument definitions **before approval**. Profiles are `generic-command` and `rust-bevy`. Initialization refuses existing target files. Rust application files (including their own Cargo.lock) are package templates, never engine dependencies.

Daily protocol: write a brief; `plan --brief ... --out ...` creates a bounded live draft (manual YAML import works offline); review/edit and commit policy/plan; `task import --file ...`; `approve --milestone ...`; `resume`; `run --max-ms 3600000`; inspect `status`, `logs`, `mail`, `checkpoint`; `answer --question ... --body ...`; review evidence; `promote --target main` explicitly. All commands require `--repo`. Results are JSON; help is conventional CLI text. Exit 0 is success, 1 is error, 2 is unverified demo/graphical evidence.

Single-machine SQLite WAL state is canonical under Git common-dir, outside linked checkouts. Worker tools use a scoped bearer token plus bound session. The operator credential is a separate mode-0600 runtime file. When running, CLI mutations use the authenticated loopback API; when stopped, maintenance acquires exclusive ownership. `pause`, `resume`, `drain`, `stop`, `retry`, `resolve-action`, `backup` and `restore` expose recovery. Backups use SQLite's backup API. Restore requires a missing destination; preserve old state before restoring and reconcile processes before resume.

The engine loads compiled modules once and records their hash. Stop owned workers before rebuilding or upgrading. HTTP timeouts and missing notifications are reconciled with history; uncertain outcomes pause. Leases never prove process termination. No exactly-once guarantee for arbitrary commands. PID start identity is verified on Linux; other platforms may conservatively require operator reconciliation.

Permissions/worktrees are **not OS isolation**. Commands execute approved project code on the host. A policy `sandbox: { executable, args }` launcher hook can wrap commands/servers; no container isolation is supplied or claimed. Budgets are finite observed limits; in-flight provider usage can exceed observed totals and monetary usage may be unknown. No automatic permissions, dependency approvals or remote push.

Source distribution operator documentation is in `docs/runbook.md`, `docs/operating-protocol.md`, and `docs/bootstrap/audit.md`. JSON Schemas are shipped in `schemas/`; Zod adds cross-field and graph/path boundary validation at runtime.
