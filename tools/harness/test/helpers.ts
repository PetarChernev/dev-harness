import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSchema, taskSchema, planSchema } from '../src/schema.js';
import type { TaskSpec } from '../src/schema.js';
import { git, runtimeLocation } from '../src/util.js';
import { Ownership } from '../src/ownership.js';
import { Store } from '../src/store.js';
import { Workspaces } from '../src/workspace.js';
import { StateService } from '../src/service.js';
import { FakeRuntime } from '../src/runtime.js';
import { CommandRunner } from '../src/commands.js';
import { Verifier, Integrator } from '../src/verification.js';
import { Supervisor } from '../src/supervisor.js';

export function spec(id = 'a', extra: Partial<TaskSpec> = {}): TaskSpec {
  return taskSchema.parse({ id, revision: 1, milestone: 'm', objective: `Create ${id}.txt with verified content`, role: 'implementer', editablePaths: [`${id}.txt`], acceptance: [`${id}.txt contains complete`], verification: ['test'], limits: { noProgress: 3, elapsedMs: 60_000 }, ...extra });
}
export async function fixture(slots = 3, check = 'process.exit(0)') {
  const root = mkdtempSync(join(tmpdir(), 'harness-test-')), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  // Test identities are confined to disposable repositories, never applied to operator checkout/config.
  writeFileSync(join(repo, 'README.md'), 'Disposable offline acceptance repository\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-m', 'test base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const { runtime } = runtimeLocation(repo);
  let owner = new Ownership(runtime), store = new Store(join(runtime, 'state.sqlite'), owner);
  const policy = projectSchema.parse({ schemaVersion: 1, name: 'fixture', profile: 'generic-command', roles: { implementer: { instructions: 'Implement approved tasks.' }, reviewer: { instructions: 'Review only.', readOnly: true } }, commands: { test: { executable: process.execPath, args: ['-e', check], buildJobs: 1 } }, resources: { implementations: slots, verification: 1, graphical: 1, buildJobs: 2 }, pollMs: 10 });
  const runtimeAdapter = new FakeRuntime(), workspaces = new Workspaces(repo, runtime);
  const assemble = () => {
    const service = new StateService(store, workspaces), runner = new CommandRunner(store, runtime, policy), verifier = new Verifier(store, workspaces, runner), integrator = new Integrator(store, workspaces, verifier);
    service.runner = runner;
    const supervisor = new Supervisor(store, service, workspaces, runtimeAdapter, policy, verifier, integrator);
    return { service, runner, verifier, integrator, supervisor };
  };
  let components = assemble(); await components.service.listen(); store.setMeta('mode', 'running');
  return {
    root, repo, runtime, base, policy, runtimeAdapter, workspaces,
    get store() { return store; }, get service() { return components.service; }, get verifier() { return components.verifier; }, get integrator() { return components.integrator; }, get supervisor() { return components.supervisor; }, get runner() { return components.runner; },
    approve(tasks: TaskSpec[]) { store.importPlan(planSchema.parse({ schemaVersion: 1, milestone: 'm', baseCommit: base, tasks })); store.approve('m', policy); },
    async restart() { await components.service.close(); store.close(); owner.close(); owner = new Ownership(runtime); store = new Store(join(runtime, 'state.sqlite'), owner); components = assemble(); await components.service.listen(); await components.supervisor.recover(); },
    async cleanup() { await components.supervisor.stopWorkers(); await components.service.close(); store.close(); owner.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
export function commit(workspace: string, name: string, content: string): string {
  writeFileSync(join(workspace, name), content); git(workspace, ['add', '--', name]);
  git(workspace, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness-test@example.invalid', 'commit', '-m', `implement ${name}`]);
  return git(workspace, ['rev-parse', 'HEAD']);
}
