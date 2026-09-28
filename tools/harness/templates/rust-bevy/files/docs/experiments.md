# Experiment artifact convention

Record a hypothesis, exact code revision (and dirty state), configuration hash, seed and input hash, executable/argument array, environment versions, machine-readable results and limitations. Store large outputs under ignored `artifacts/` or the harness-provided `HARNESS_ARTIFACT_DIR`. The scheduler understands commands and artifacts, not simulation-specific metrics.

The tiny example in `experiments/example.json` tests whether seeded integer motion and timed commands replay identically. Run `node scripts/replay.mjs`. It runs the same pinned headless build twice and compares complete state and digest; `first.json`, `second.json` and `replay.json` preserve evidence. The command/output path differs between runs, so compare the state digest rather than the entire metadata file.

`project_core` has no Bevy renderer, windows, audio or GPU dependency. The desktop app wraps exactly the same `Simulation::step` as the headless runner, then converts integer positions into generated rectangular geometry. The simulation advances by explicit ticks, not wall time. Interactive desktop speed is display-dependent; use explicit `--ticks` to compare final state. No cross-platform bitwise claim is made.

```sh
cargo test --locked
cargo run --locked -p headless -- --seed 42 --ticks 120 --input experiments/example.json --output artifacts/result.json
node scripts/replay.mjs
cargo run --locked -p desktop
node scripts/desktop-smoke.mjs
```

The default Cargo workspace members are core/headless only. Desktop build/smoke are separate opt-in gates. A missing display/GPU yields **unverified**, never passed. Graphical smoke uses a unique screenshot path, 120 ticks, a 60-second in-app timeout and a 10-minute external build/run cap.
