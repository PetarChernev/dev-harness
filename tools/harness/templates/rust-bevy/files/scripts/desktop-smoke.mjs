import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const output = resolve(process.env.HARNESS_ARTIFACT_DIR ?? 'artifacts/desktop'); mkdirSync(output, { recursive: true });
const report = { schemaVersion: 1, result: 'unverified', command: [], screenshot: null, reason: null };
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  report.reason = 'No display configured; graphical smoke unverified (exit 2).';
  writeFileSync(join(output, 'smoke.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exit(2);
}
const screenshot = join(output, `frame-${randomUUID()}.png`);
const args = ['run', '--locked', '-p', 'desktop', '--', '--seed', '42', '--ticks', '120', '--input', 'experiments/example.json', '--screenshot', screenshot];
report.command = ['cargo', ...args];
const result = spawnSync('cargo', args, { encoding: 'utf8', timeout: 600_000, env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' }, maxBuffer: 4 * 1024 * 1024 });
writeFileSync(join(output, 'output.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
const image = existsSync(screenshot) ? readFileSync(screenshot) : Buffer.alloc(0);
const validPng = image.length > 100 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
const state = (result.stdout ?? '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(line => line.graphical === 'rendered');
const headlessPath = join(output, 'headless-reference.json');
const headless = state ? spawnSync('cargo', ['run', '--locked', '-p', 'headless', '--', '--seed', '42', '--ticks', '120', '--input', 'experiments/example.json', '--output', headlessPath], { encoding: 'utf8', timeout: 180_000 }) : null;
const sameCore = headless?.status === 0 && JSON.parse(readFileSync(headlessPath, 'utf8')).results.stateDigest === state.stateDigest;
report.result = !result.error && result.status === 0 && validPng && sameCore ? 'passed' : 'unverified'; report.screenshot = validPng ? screenshot : null;
report.sameCoreDigest = sameCore; report.stateDigest = state?.stateDigest ?? null;
report.reason = result.error?.message ?? (report.result === 'passed' ? null : `exit ${result.status}, screenshot valid: ${validPng}`);
writeFileSync(join(output, 'smoke.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); process.exit(report.result === 'passed' ? 0 : 2);
