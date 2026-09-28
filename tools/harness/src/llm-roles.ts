import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { planSchema, taskSchema, validateGraph } from './schema.js';
import type { Project, TaskSpec } from './schema.js';
import type { StateService } from './service.js';
import type { Store, TaskRow } from './store.js';
import { WorkerStartError } from './runtime.js';
import type { WorkerRuntime, WorkerHandle } from './runtime.js';
import type { Workspaces } from './workspace.js';
import { canonical, hash, sleep, uid } from './util.js';

function jsonResult(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(stripped);
}
/** Planner/reviewer use the same owned runtime and persistent dispatch identities, with one bounded read-only turn. */
export async function readOnlyTurn(store: Store, service: StateService, runtime: WorkerRuntime, policy: Project, task: TaskSpec, directory: string, prompt: string, registerTask?: TaskRow): Promise<{ output: unknown; session: string }> {
  const id = uid('role'), token = randomBytes(32).toString('hex'), action = uid('role_action'), requestId = `msg_${randomBytes(16).toString('hex')}`;
  store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', action, task.id, 'readonly-role', 'intent', canonical({ role: task.role, requestId, directory }), null, Date.now());
  if (registerTask) store.run('INSERT INTO workers VALUES (?,?,?,?,?,?,?,?,?,?)', id, registerTask.id, registerTask.revision, registerTask.attempt, null, null, 'starting', hash(token), 2, Date.now());
  let handle: WorkerHandle;
  try { handle = await runtime.start({ id, directory, task, policy, controlUrl: service.url, token, readOnly: true }); }
  catch (error) {
    const stopped = error instanceof WorkerStartError && error.stopped;
    store.run('UPDATE actions SET status=? WHERE id=?', stopped ? 'failed' : 'uncertain', action);
    if (registerTask) store.run('UPDATE workers SET status=? WHERE id=?', stopped ? 'stopped' : 'uncertain', id);
    throw error;
  }
  store.run('UPDATE actions SET data=?,status=? WHERE id=?', canonical({ handle, requestId, role: task.role }), 'running', action);
  if (registerTask) store.run("UPDATE workers SET session=?,handle=?,status='active' WHERE id=?", handle.session, canonical(handle), id);
  try {
    if (registerTask) store.run('INSERT INTO dispatches VALUES (?,?,?,?,?,?,?)', requestId, id, handle.session, 'intent', prompt, Date.now(), null);
    const acceptance = await runtime.dispatch(handle, requestId, prompt);
    if (acceptance === 'rejected') throw new Error('read-only role dispatch rejected');
    const end = Date.now() + Math.min(task.limits.elapsedMs, 120_000);
    while (Date.now() < end) {
      const state = await runtime.status(handle);
      if (state.state === 'permission') throw new Error(`read-only role pending permission: ${state.permissionIds?.join(',')}`);
      if (state.state === 'unavailable' || state.state === 'missing') throw new Error('read-only session unobservable; action uncertain');
      if (state.state === 'idle') {
        const history = await runtime.messages(handle), replies = history.filter(m => m.parent === requestId && m.complete && m.role === 'assistant'), result = replies.at(-1);
        if (!history.some(m => m.id === requestId)) throw new Error('ambiguous read-only dispatch; no automatic retry');
        if (!result) { await sleep(100); continue; }
        if (result.error) throw new Error(`read-only role error: ${result.error}`);
        const output = jsonResult(result.text);
        store.run("UPDATE actions SET status='finished',result=? WHERE id=?", canonical({ output, session: handle.session, tokens: replies.some(m => m.tokens === null) ? null : replies.reduce((sum, m) => sum + m.tokens!, 0), cost: replies.some(m => m.cost === null) ? null : replies.reduce((sum, m) => sum + m.cost!, 0) }), action);
        if (registerTask) store.run("UPDATE dispatches SET status='completed',result=? WHERE id=?", canonical({ message: result.id }), requestId);
        return { output, session: handle.session };
      }
      await sleep(500);
    }
    throw new Error('bounded read-only role time budget exhausted');
  } finally {
    const stopped = await runtime.cancel(handle);
    if (registerTask) store.run('UPDATE workers SET status=? WHERE id=?', stopped === 'stopped' ? 'stopped' : 'uncertain', id);
    store.run("UPDATE actions SET status=? WHERE id=? AND status!='finished'", stopped === 'stopped' ? 'failed' : 'uncertain', action);
    if (registerTask) store.run("UPDATE dispatches SET status='cancelled' WHERE id=? AND status!='completed'", requestId);
    if (stopped !== 'stopped') { store.run("UPDATE actions SET status='uncertain' WHERE id=?", action); throw new Error('read-only role process termination is uncertain; reconcile before accepting its result'); }
  }
}
export function reviewer(store: Store, service: StateService, runtime: WorkerRuntime) {
  return async (task: TaskRow, directory: string, candidate: string): Promise<{ passed: boolean; findings: string[]; session: string }> => {
    const policy = store.policy(task), spec = store.spec(task), role = policy.integration.reviewRole;
    if (!role || !policy.roles[role]?.readOnly) throw new Error('independent read-only reviewer required');
    const result = await readOnlyTurn(store, service, runtime, policy, { ...spec, role, limits: { ...spec.limits, prompts: 1, steps: Math.min(spec.limits.steps, 10), elapsedMs: Math.min(spec.limits.elapsedMs, 120_000) } }, directory,
      `Independently review candidate ${candidate} against base ${task.baseCommit}. Inspect git diff and relevant files. Do not edit, submit implementation, spawn agents, or change criteria. Final answer MUST be JSON only: {"passed": boolean, "findings": string[]}. Acceptance: ${JSON.stringify(spec)}. Deterministic evidence: ${JSON.stringify(store.all('SELECT kind,data FROM evidence WHERE task=? AND valid=1', task.id))}`, task);
    return { ...z.object({ passed: z.boolean(), findings: z.array(z.string()) }).strict().parse(result.output), session: result.session };
  };
}
export async function generatePlan(store: Store, service: StateService, workspaces: Workspaces, runtime: WorkerRuntime, policy: Project, briefFile: string, outFile: string): Promise<unknown> {
  const role = policy.roles.planner; if (!role?.readOnly) throw new Error('configure a read-only planner role');
  const baseCommit = workspaces.commit('HEAD'), directory = workspaces.candidate(baseCommit, 'planner');
  const task = taskSchema.parse({ id: 'planner', revision: 1, milestone: 'planning', kind: 'research', objective: 'Draft a bounded plan', role: 'planner', editablePaths: [], acceptance: ['Schema-valid draft graph'], verification: [Object.keys(policy.commands)[0] ?? 'check'], artifacts: ['plan.yaml'], limits: { ...policy.defaults, prompts: 1, steps: Math.min(policy.defaults.steps, 10), elapsedMs: 120_000 } });
  const result = await readOnlyTurn(store, service, runtime, policy, task, directory,
    `Propose a small bounded dependency graph only for this brief: ${readFileSync(resolve(briefFile), 'utf8')}. Inspect relevant files without edits. Final answer MUST be JSON matching this schema: ${JSON.stringify(z.toJSONSchema(planSchema))}. baseCommit MUST be ${baseCommit}. Available approved role templates and command IDs: ${JSON.stringify(policy)}. Every task must include editablePaths, explicit acceptance and finite limits. Do not approve, import or execute implementation. No game/content scope unless in the brief.`);
  const plan = planSchema.parse(result.output); validateGraph(plan);
  if (plan.baseCommit !== baseCommit) throw new Error('planner changed base commit');
  for (const spec of plan.tasks) {
    if (!policy.roles[spec.role] || spec.verification.some(c => !policy.commands[c])) throw new Error('planner used unknown roles/commands');
    for (const key of Object.keys(policy.defaults) as (keyof Project['defaults'])[]) if (spec.limits[key] > policy.defaults[key]) throw new Error(`planner exceeded approved planning envelope: ${key}`);
  }
  writeFileSync(resolve(outFile), stringify(plan), { flag: 'wx' }); return { state: 'draft', output: resolve(outFile), session: result.session, approvalRequired: true, plan };
}
