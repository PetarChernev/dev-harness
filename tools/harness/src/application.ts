import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { Ownership } from './ownership.js';
import { Store } from './store.js';
import type { ActionRow, WorkerRow } from './store.js';
import { Workspaces } from './workspace.js';
import { StateService } from './service.js';
import { CommandRunner } from './commands.js';
import { Verifier, Integrator } from './verification.js';
import { Supervisor } from './supervisor.js';
import type { WorkerRuntime } from './runtime.js';
import { loadProject, packageRoot } from './profiles.js';
import { canonical, git, hash, runtimeLocation } from './util.js';
import { projectSchema } from './schema.js';
import { OpenCodeRuntime } from './opencode.js';
import { generatePlan, reviewer } from './llm-roles.js';

export function status(store: Store): unknown {
  return { schemaVersion: 1, mode: store.meta('mode', 'stopped'), release: store.meta('release', null),
    tasks: store.tasks().map(task => ({ ...task, nextAction: ({ draft: 'review and approve milestone', ready: 'await satisfied dependencies/capacity or resume', running: 'reconcile session and continue useful work', submitted: 'stop writer and verify independently', verifying: 'await approved command evidence', integration: 'rerun combined checks and serialize advance', done: 'review integrated evidence; explicit promotion', blocked: 'await addressed reply', needs_human: 'operator must resolve blocker', failed: 'inspect evidence; bounded retry or new revision', cancelled: 'preserved; explicit retry only' } as const)[task.state],
      session: task.worker ? store.worker(task.worker).session : null,
      model: task.worker && store.worker(task.worker).handle ? store.handle(store.worker(task.worker)).metadata.model ?? 'unknown' : 'not started',
      evidence: store.all('SELECT id,kind,created,valid FROM evidence WHERE task=? ORDER BY created', task.id),
      consumption: { scope: 'observed implementation turns', prompts: task.prompts, tokens: task.tokens ?? 'unknown', costUsd: task.cost ?? 'unknown', knownLowerBound: store.meta(`usage:${task.id}@${task.revision}`, { knownTokens: task.tokens ?? 0, knownCost: task.cost ?? 0 }), unmeasuredTurns: store.get<{ count: number }>("SELECT count(*) count FROM dispatches d JOIN workers w ON w.id=d.worker WHERE w.task=? AND w.revision=? AND d.status IN ('intent','accepted','uncertain','cancelled')", task.id, task.revision)!.count },
      limits: store.spec(task).limits,
      observedOverage: { tokens: Math.max(0, (task.tokens ?? 0) - store.spec(task).limits.tokens), costUsd: task.cost === null ? 'unknown' : Math.max(0, task.cost - store.spec(task).limits.costUsd) },
    })),
    pendingMail: store.all('SELECT id,thread,sender,recipient,task,type,delivered,acknowledged FROM messages WHERE acknowledged IS NULL'),
    workers: store.all('SELECT id,task,revision,attempt,session,status,readOnly,created FROM workers ORDER BY created'),
    readOnlyRoleConsumption: store.all<{ id: string; task: string; result: string | null }>("SELECT id,task,result FROM actions WHERE kind IN ('readonly-role','responder')").map(action => { const result = action.result ? JSON.parse(action.result) as { tokens?: number | null; cost?: number | null; session?: string } : null; return { id: action.id, task: action.task, session: result?.session ?? null, tokens: result?.tokens ?? 'unknown', costUsd: result?.cost ?? 'unknown' }; }),
    unresolvedActions: store.all("SELECT * FROM actions WHERE status IN ('intent','running','uncertain')"),
    integrations: store.all('SELECT * FROM integrations ORDER BY created'),
  };
}
export function releaseIdentity(): { version: string; hash: string; build: unknown } {
  const directory = join(packageRoot, 'dist');
  const sources = readdirSync(directory).filter(p => p.endsWith('.js')).sort().map(p => [p, readFileSync(join(directory, p), 'utf8')]);
  const build: unknown = existsSync(join(directory, 'build-info.json')) ? JSON.parse(readFileSync(join(directory, 'build-info.json'), 'utf8')) : null;
  const lock = existsSync(join(packageRoot, 'npm-shrinkwrap.json')) ? hash(readFileSync(join(packageRoot, 'npm-shrinkwrap.json'))) : z.object({ dependencyLock: z.string() }).passthrough().parse(build).dependencyLock;
  return { version: '0.1.0', hash: hash({ sources, workerTools: readFileSync(join(packageRoot, 'templates/opencode/harness.ts'), 'utf8'), manifest: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')), lock }), build };
}
export function openApplication(repoInput: string, runtimeAdapter: WorkerRuntime, explicitRuntime?: string) {
  const { repo, runtime } = runtimeLocation(repoInput, explicitRuntime), policy = loadProject(repo), ownership = new Ownership(runtime);
  let store: Store;
  try { store = new Store(join(runtime, 'state.sqlite'), ownership); } catch (error) { ownership.close(); throw error; }
  const workspaces = new Workspaces(repo, runtime), service = new StateService(store, workspaces), runner = new CommandRunner(store, runtime, policy);
  service.runner = runner;
  const verifier = new Verifier(store, workspaces, runner, reviewer(store, service, runtimeAdapter)), integrator = new Integrator(store, workspaces, verifier), supervisor = new Supervisor(store, service, workspaces, runtimeAdapter, policy, verifier, integrator);
  let supervised = false;
  const operate = async (action: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    switch (action) {
      case 'status': return status(store);
      case 'logs': return store.all('SELECT * FROM events ORDER BY seq DESC LIMIT 200');
      case 'import': {
        const { file } = z.object({ file: z.string() }).strict().parse(input);
        const text = readFileSync(file, 'utf8'), plan = store.importPlan(parse(text));
        store.setMeta(`plan-source:${plan.milestone}`, { file, hash: hash(plan) }); return plan;
      }
      case 'approve': {
        const { milestone } = z.object({ milestone: z.string() }).strict().parse(input);
        const committed = projectSchema.parse(parse(git(repo, ['show', 'HEAD:.harness/project.yaml'])));
        if (supervised && hash(committed) !== hash(policy)) throw new Error('stop before approving a changed supervisor policy');
        if (hash(committed) !== hash(loadProject(repo))) throw new Error('commit project policy before approval');
        const source = store.meta<{ file: string; hash: string } | null>(`plan-source:${milestone}`, null);
        if (!source) throw new Error('import a versioned plan before approval');
        const relative = source.file.startsWith(repo + '/') ? source.file.slice(repo.length + 1) : source.file;
        if (relative.startsWith('/') || relative.includes('..')) throw new Error('plan must be versioned in target repository');
        const committedPlan = parse(git(repo, ['show', `HEAD:${relative}`]));
        const { planSchema } = await import('./schema.js');
        if (hash(planSchema.parse(committedPlan)) !== source.hash) throw new Error('commit exact imported plan before approval');
        for (const task of store.tasks().filter(t => t.milestone === milestone)) {
          workspaces.commit(task.baseCommit);
          const decision = store.spec(task).decisionRecord; if (decision) git(repo, ['show', `${task.baseCommit}:${decision}`]);
        }
        const approval = store.approve(milestone, committed);
        return { approval, defaults: committed.defaults, resources: committed.resources, approved: store.tasks().filter(t => t.approval === approval).map(t => ({ id: t.id, revision: t.revision, limits: store.spec(t).limits })) };
      }
      case 'answer': return service.answer(input);
      case 'permission': {
        const { worker, request, reply } = z.object({ worker: z.string(), request: z.string(), reply: z.enum(['once', 'reject']) }).strict().parse(input);
        if (!(runtimeAdapter instanceof OpenCodeRuntime)) throw new Error('permission reply requires a live OpenCode runtime');
        const owner = store.worker(worker);
        if (reply === 'once' && store.tasks().filter(t => ['running', 'submitted'].includes(t.state)).length >= policy.resources.implementations) throw new Error('wait for implementation capacity before resuming a permission-blocked worker');
        await runtimeAdapter.permission(store.handle(owner), request, reply);
        store.event('permission', 'operator explicitly answered scoped permission request', owner.task, { worker, request, reply });
        if (store.task(owner.task).state === 'needs_human') { store.updateTask(owner.task, { state: 'running', blocker: null }); }
        return { request, reply };
      }
      case 'permissions': {
        const { worker } = z.object({ worker: z.string() }).strict().parse(input);
        if (!(runtimeAdapter instanceof OpenCodeRuntime)) throw new Error('requires live runtime');
        return runtimeAdapter.permissions(store.handle(store.worker(worker)));
      }
      case 'plan': {
        const { brief, out } = z.object({ brief: z.string(), out: z.string() }).strict().parse(input);
        if (!service.url) await service.listen();
        return generatePlan(store, service, workspaces, runtimeAdapter, policy, brief, out);
      }
      case 'mail': { const { recipient } = z.object({ recipient: z.string().default('operator') }).strict().parse(input); const mail = service.readMail(recipient); service.delivered(recipient, mail.map(m => m.id)); return mail; }
      case 'verify': case 'integrate': {
        if (supervised) throw new Error('automatic pipeline owns verification/integration; stop supervisor before manual maintenance');
        const { task } = z.object({ task: z.string() }).strict().parse(input); return { passed: await (action === 'verify' ? verifier.verify(task) : integrator.integrate(task)) };
      }
      case 'promote': { if (supervised) throw new Error('stop before promotion'); const { target } = z.object({ target: z.string() }).strict().parse(input); workspaces.promote(policy, target); store.event('promotion', 'operator explicitly promoted verified branch', null, { target }); return { target }; }
      case 'backup': { const { file } = z.object({ file: z.string() }).strict().parse(input); await store.backup(file); return { backup: file }; }
      case 'resolve-action': {
        const { id, reason } = z.object({ id: z.string(), reason: z.string().min(1) }).strict().parse(input);
        const action = store.get<ActionRow>('SELECT * FROM actions WHERE id=?', id); if (!action || action.status !== 'uncertain') throw new Error('action not uncertain');
        store.run("UPDATE actions SET status='reconciled',result=? WHERE id=?", canonical({ operatorReason: reason }), id); store.event('reconciliation', reason, action.task, { id }); return { reconciled: id };
      }
      default: return supervisor.control(action, input);
    }
  };
  service.onControl = operate;
  return { repo, runtime, ownership, store, policy, service, runner, verifier, integrator, supervisor, operate,
    async run(maxMs: number, exitOnBlocked = false) {
      const release = releaseIdentity(), previous = store.meta<{ hash: string } | null>('release', null);
      if (previous && previous.hash !== release.hash && store.all<WorkerRow>("SELECT * FROM workers WHERE status!='stopped'").length) throw new Error('harness upgrade requires controlled stop of previous revision');
      for (const task of store.tasks().filter(t => t.approval && !['done', 'draft', 'cancelled'].includes(t.state))) if (hash(store.policy(task)) !== hash(policy)) throw new Error('current project policy differs from approval snapshot; restore it or explicitly revise and approve');
      store.setMeta('release', release); store.event('release', 'compiled modules loaded once; source edits are not hot-reloaded', null, release);
      supervised = true; await service.listen(); await supervisor.run(maxMs, exitOnBlocked);
    },
    async close() { await service.close(); store.close(); ownership.close(); },
  };
}

export async function remoteOperation(runtime: string, action: string, input: unknown): Promise<{ connected: boolean; output?: unknown }> {
  if (!existsSync(join(runtime, 'endpoint.json'))) return { connected: false };
  const { url } = z.object({ url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), pid: z.number() }).parse(JSON.parse(readFileSync(join(runtime, 'endpoint.json'), 'utf8')));
  const { token } = z.object({ token: z.string() }).parse(JSON.parse(readFileSync(join(runtime, 'operator.json'), 'utf8')));
  let response: Response;
  try { response = await fetch(`${url}/operator/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) }); }
  catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('operator request outcome uncertain; inspect status before retrying');
    return { connected: false };
  }
  const output: unknown = await response.json(); if (!response.ok) throw new Error(JSON.stringify(output)); return { connected: true, output };
}
