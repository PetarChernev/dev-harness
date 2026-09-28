import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeRuntime } from '../dist/opencode.js';
import { Workspaces } from '../dist/workspace.js';
import { Ownership } from '../dist/ownership.js';
import { loadProject } from '../dist/profiles.js';
import { taskSchema } from '../dist/schema.js';
import { privateWrite, runtimeLocation, uid } from '../dist/util.js';

// No model call: validate repo-local custom tools in a fresh, dependency-free Git checkout.
const { repo, runtime } = runtimeLocation(process.argv[2] ?? '.'), owner = new Ownership(runtime);
const workspaces = new Workspaces(repo, runtime), policy = loadProject(repo), directory = workspaces.candidate(workspaces.commit('HEAD'), 'api-probe');
const adapter = new OpenCodeRuntime(runtime), workerId = uid('api_probe'); let handle;
const report = { result: 'unverified', modelCalls: 0, directory, applicationDependenciesPresent: existsSync(join(directory, 'tools/harness/node_modules')) };
try {
  const role = Object.keys(policy.roles).find(name => !policy.roles[name].readOnly);
  const task = taskSchema.parse({ id: 'api-probe', revision: 1, milestone: 'probe', objective: 'Inspect tools only', role, editablePaths: [], acceptance: ['Scoped tools load without checkout dependencies'], verification: [Object.keys(policy.commands)[0]], limits: { prompts: 1, steps: 2, elapsedMs: 30_000 } });
  handle = await adapter.start({ id: workerId, task, policy, directory, controlUrl: 'http://127.0.0.1:1', token: uid('scope'), readOnly: true });
  const secret = JSON.parse(readFileSync(handle.metadata.secretFile, 'utf8'));
  const client = createOpencodeClient({ baseUrl: handle.metadata.baseUrl, directory, headers: { Authorization: `Basic ${Buffer.from(`opencode:${secret.password}`).toString('base64')}` } });
  const tools = (await client.tool.ids({ directory }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })).data;
  report.scopedTools = tools.filter(name => name.startsWith('harness_'));
  report.resumption = await adapter.resume(handle);
  report.result = !report.applicationDependenciesPresent && ['harness_context', 'harness_evidence', 'harness_mail_send', 'harness_mail_read', 'harness_mail_ack', 'harness_checkpoint', 'harness_check', 'harness_block', 'harness_submit'].every(name => tools.includes(name)) && report.resumption === 'owned' ? 'passed' : 'unverified';
} catch (error) { report.reason = error instanceof Error ? error.message : String(error); }
finally {
  report.ownedProcessStopped = handle ? await adapter.cancel(handle) === 'stopped' : (await adapter.reconcileStart(workerId)).state === 'stopped';
  privateWrite(join(runtime, 'worktree-api-probe.json'), report); owner.close();
}
console.log(JSON.stringify(report, null, 2)); if (report.result !== 'passed' || !report.ownedProcessStopped) process.exitCode = 2;
