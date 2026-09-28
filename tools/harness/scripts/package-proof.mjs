import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(join(tmpdir(), 'harness-package-proof-'));
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', GIT_AUTHOR_NAME: 'Harness Packaging Test', GIT_AUTHOR_EMAIL: 'packaging@example.invalid', GIT_COMMITTER_NAME: 'Harness Packaging Test', GIT_COMMITTER_EMAIL: 'packaging@example.invalid' } });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const packOutput = run('npm', ['pack', '--json', '--pack-destination', output]);
const packed = JSON.parse(packOutput.slice(packOutput.indexOf('[\n')))[0];
assert.equal(packed.files.some(file => file.path === 'npm-shrinkwrap.json'), true, 'tarball must carry transitive dependency pinning');
const installer = join(output, 'installer'); mkdirSync(installer);
writeFileSync(join(installer, 'package.json'), JSON.stringify({ name: 'offline-package-proof', version: '1.0.0', private: true }));
run('npm', ['install', '--offline', '--ignore-scripts', '--save-exact', join(output, packed.filename)], installer);
const binary = join(installer, 'node_modules/.bin/harness');
const help = run(binary, ['--help'], installer); assert.match(help, /plan/); assert.match(help, /restore/);
const repo = join(output, 'generic-repository');
run(binary, ['init', '--repo', repo, '--profile', 'generic-command'], installer);
assert.equal(JSON.parse(run(binary, ['status', '--repo', repo], installer)).mode, 'uninitialized');
const demoRepo = join(output, 'mock-workflow');
const demo = JSON.parse(run(binary, ['demo', '--repo', demoRepo, '--mode', 'mock'], installer));
assert.equal(demo.result, 'passed'); assert.equal(demo.ownedProcessesStopped, true); assert.equal(demo.status.tasks.length, 2);
assert.equal(packed.files.some(f => /templates\/rust-bevy\/files\/Cargo.lock/.test(f.path)), true);
assert.equal(packed.files.some(f => /templates\/rust-bevy\/files\/\.cargo\/config.toml/.test(f.path)), true);
const sources = packed.files.filter(f => f.path.startsWith('dist/') && f.path.endsWith('.js')).map(f => readFileSync(join(root, f.path), 'utf8')).join('\n');
assert.doesNotMatch(sources, /from\s+['"][^'"]*(?:crates\/|project_core)/);
const report = { schemaVersion: 1, result: 'passed', install: 'npm install --offline --ignore-scripts (uses populated npm cache; no model/Rust/GPU)', tarball: join(output, packed.filename), packageIntegrity: packed.integrity, genericRepo: repo, mockEvidence: demo.evidence, output };
writeFileSync(join(output, 'proof.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
