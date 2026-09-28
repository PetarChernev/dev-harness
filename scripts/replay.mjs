import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve(process.env.HARNESS_ARTIFACT_DIR ?? 'artifacts/replay');
mkdirSync(output, { recursive: true });
const args = ['run', '--locked', '-p', 'headless', '--', '--seed', '42', '--ticks', '120', '--input', 'experiments/example.json'];
for (const name of ['first', 'second']) {
  const result = spawnSync('cargo', [...args, '--output', join(output, `${name}.json`)], { encoding: 'utf8', timeout: 180_000, env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' } });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
}
const first = JSON.parse(readFileSync(join(output, 'first.json'), 'utf8')), second = JSON.parse(readFileSync(join(output, 'second.json'), 'utf8'));
assert.equal(first.configurationHash, second.configurationHash);
assert.equal(first.results.stateDigest, second.results.stateDigest);
assert.deepEqual(first.results.state, second.results.state);
assert.equal(first.results.state.tick, 120);
const evidence = { schemaVersion: 1, passed: true, command: ['node', 'scripts/replay.mjs'], first: 'first.json', second: 'second.json', stateDigest: first.results.stateDigest, limitations: first.limitations };
writeFileSync(join(output, 'replay.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ ...evidence, output }, null, 2));
