# Local harness and neutral Rust/Bevy starter

A reusable, local-first OpenCode development harness lives in **`tools/harness/`**. The root Rust application is a separate generated sample: seeded integer motion, a command/state interface, and neutral generated rectangles. `project_core` is shared by the desktop and headless executables and has no rendering/window/audio dependency.

## Quick start

Use Node **24.21.0**, npm **11.19.0**, Rust **1.95.0**, and the committed lockfiles. In this bootstrap checkout, Node was installed locally:

```sh
export PATH="$PWD/.local/node-v24.21.0-linux-x64/bin:$PATH"
npm --prefix tools/harness ci
npm run test:harness
npm run harness -- status --repo .

cargo test --locked
node scripts/replay.mjs
cargo run --locked -p desktop
```

Explicit headless experiment:

```sh
cargo run --locked -p headless -- \
  --seed 42 --ticks 120 --input experiments/example.json --output artifacts/result.json
```

Graphical gate (finite exit and screenshot): `node scripts/desktop-smoke.mjs`.

## Operate and reuse

See [the operator runbook](docs/runbook.md) for the complete brief → draft → approval → execution → review → promotion workflow and recovery. Start with `npm run harness -- --help`. Runtime status is SQLite-backed; bootstrap handoff is [progress.md](docs/bootstrap/progress.md).

```sh
npm --prefix tools/harness run test:package
npm --prefix tools/harness pack
# In another npm repository, install that local tarball:
npm install --save-dev /absolute/path/to/local-first-dev-harness-0.1.0.tgz
npx --no-install harness init --repo /absolute/path/to/target --profile generic-command
```

No remote repository or published package is needed. Offline harness tests use real temporary Git repositories, SQLite and harmless subprocesses; they require neither OpenCode/model credentials nor Rust/GPU access.

## Evidence and boundaries

- [Compatibility/preflight](docs/bootstrap/preflight.md)
- [Actual live two-session smoke](docs/bootstrap/live-smoke.md)
- [Acceptance audit and exact reproductions](docs/bootstrap/audit.md)
- [Architecture](docs/architecture.md), [protocol](docs/operating-protocol.md), [decisions](docs/decisions.md)
- [Experiment convention](docs/experiments.md)

This is **trusted-local v1**, not an OS security sandbox or a production-hardening claim. Owned OpenCode servers are authenticated and loopback-bound. Uncertain external actions/ownership pause rather than being blindly duplicated. Token/money limits are observation-based; in-flight usage and unknown monetary prices are reported explicitly. Push is not automated.

Quit and restart OpenCode to load the installed repo-local agents/tools and `/harness-status`, `/harness-plan`, `/bootstrap-resume` commands.
