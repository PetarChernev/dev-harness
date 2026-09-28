import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeRuntime } from '../dist/opencode.js';
import { WorkerStartError } from '../dist/runtime.js';
import { projectSchema, taskSchema } from '../dist/schema.js';
import { git, privateWrite, uid, sleep } from '../dist/util.js';

// Explicit optional live probe: one existing-model prompt, 2 steps, 45s. Never grants a permission.
const root = mkdtempSync(join(tmpdir(), 'harness-permission-probe-')), directory = join(root, 'checkout'), runtimePath = join(root, 'runtime');
mkdirSync(directory); mkdirSync(runtimePath); git(directory, ['init', '-b', 'main']); privateWrite(join(runtimePath, 'endpoint.json'), { url: 'http://127.0.0.1:1' });
const policy = projectSchema.parse({ schemaVersion: 1, name: 'permission-probe', profile: 'generic-command', roles: { reviewer: { readOnly: true, instructions: 'Perform only the exact harmless permission compatibility probe. No other tool calls, no external agents.' } }, commands: { check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } } });
const task = taskSchema.parse({ id: 'permission-probe', revision: 1, milestone: 'probe', role: 'reviewer', objective: 'Verify pending permission API without granting it', editablePaths: [], acceptance: ['Scoped pending bash request observed and rejected'], verification: ['check'], limits: { prompts: 1, steps: 2, elapsedMs: 45_000, providerRetries: 0, tokens: 10_000, costUsd: 1 } });
const runtime = new OpenCodeRuntime(runtimePath); let handle;
const workerId = uid('probe'); let startupStopped = false;
const report = { result: 'unverified', modelPrompts: 0, permissionAutomaticallyApproved: false, output: root };
try {
  handle = await runtime.start({ id: workerId, task, policy, directory, controlUrl: 'http://127.0.0.1:1', token: uid('scoped'), readOnly: true });
  report.session = handle.session; report.model = handle.metadata.model;
  report.resumption = await runtime.resume(handle);
  const id = uid('msg'); report.dispatch = await runtime.dispatch(handle, id, 'Compatibility probe: call the bash tool exactly once with command `printf compatibility-probe`. This is harmless but must ask permission under your configuration. Do not substitute a different tool or command. If rejected, stop and report rejection without retrying.'); report.modelPrompts = 1;
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const state = await runtime.status(handle);
    if (state.retryAttempt) throw new Error('provider retry observed; probe stops');
    const requests = await runtime.permissions(handle);
    if (requests.length) {
      const request = requests[0]; report.request = request;
      await runtime.permission(handle, request.id, 'reject');
      report.rejected = true; report.pendingAfterReject = await runtime.permissions(handle);
      report.result = request.permission === 'bash' && request.patterns.some(p => p.includes('printf')) && report.pendingAfterReject.length === 0 ? 'passed' : 'unverified';
      break;
    }
    if (state.state === 'idle' && (await runtime.messages(handle)).some(m => m.role === 'assistant' && m.parent === id && m.complete)) break;
    await sleep(250);
  }
} catch (error) { startupStopped = error instanceof WorkerStartError && error.stopped; report.reason = error instanceof Error ? error.message : String(error); }
finally { report.ownedProcessStopped = handle ? await runtime.cancel(handle) === 'stopped' : startupStopped || (await runtime.reconcileStart(workerId)).state === 'stopped'; writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2)); if (report.result !== 'passed' || !report.ownedProcessStopped) process.exitCode = 2;
