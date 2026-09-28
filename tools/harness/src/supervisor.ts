import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { WorkerRuntime, WorkerHandle } from './runtime.js';
import type { DispatchRow, Store, TaskRow, WorkerRow, ActionRow } from './store.js';
import { transition } from './store.js';
import type { Project } from './schema.js';
import type { StateService } from './service.js';
import type { Workspaces } from './workspace.js';
import type { Integrator, Verifier } from './verification.js';
import { canonical, errorText, hash, processState, redact, sleep, uid } from './util.js';

export class Supervisor {
  private readonly observed = new Set<string>();
  private readonly events = new AbortController();
  private readonly verification = new Map<string, Promise<void>>();
  private integrating: Promise<void> | null = null;
  private ticking = false;
  constructor(readonly store: Store, readonly service: StateService, readonly workspaces: Workspaces,
    readonly runtime: WorkerRuntime, readonly policy: Project, readonly verifier: Verifier, readonly integrator: Integrator) {}

  async recover(): Promise<void> {
    for (const action of this.store.all<ActionRow>("SELECT * FROM actions WHERE status IN ('intent','running') AND kind='command'")) {
      const data = JSON.parse(action.data) as { process?: { pid: number; start: string | null } };
      if (data.process && processState(data.process) === 'alive') {
        try { process.kill(process.platform === 'win32' ? data.process.pid : -data.process.pid, 'SIGKILL'); } catch { /* still uncertain until reconciled */ }
      }
      this.store.run("UPDATE actions SET status='uncertain' WHERE id=?", action.id);
      const task = this.store.task(action.task);
      if (!['done', 'cancelled', 'needs_human'].includes(task.state)) transition(this.store, task.id, 'needs_human', `external action ${action.id} interrupted; inspect artifacts before explicit reconciliation`);
    }
    for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE status!='stopped'")) {
      if (!worker.handle) { this.uncertain(worker, 'worker launch outcome uncertain; inspect owned process record'); continue; }
      const ownership = await this.runtime.resume(this.store.handle(worker));
      if (ownership === 'uncertain') this.uncertain(worker, 'worker process ownership uncertain; no reassignment');
      else if (ownership === 'stopped') {
        this.store.run("UPDATE workers SET status='stopped' WHERE id=?", worker.id);
        const pending = this.pending(worker);
        if (pending) { this.store.run("UPDATE dispatches SET status='uncertain' WHERE id=?", pending.id); this.uncertain(worker, 'stopped process had unresolved dispatch; inspect history before retry'); }
        else {
          const task = this.store.task(worker.task);
          if (['running', 'blocked'].includes(task.state) && !worker.readOnly) { transition(this.store, task.id, 'ready', 'old process confirmed stopped; rehydrate preserved checkout'); this.store.updateTask(task.id, { worker: null }); }
        }
      } else this.store.event('recovery', 'existing owned session recovered; reconcile history, not event replay', worker.task, { worker: worker.id, session: worker.session });
    }
    // A verifier crash before any command launch is still not evidence of a pass.
    for (const task of this.store.tasks().filter(t => t.state === 'verifying')) transition(this.store, task.id, 'needs_human', 'verification interrupted; operator must inspect actions and requeue');
  }
  private pending(worker: WorkerRow): DispatchRow | undefined { return this.store.get<DispatchRow>("SELECT * FROM dispatches WHERE worker=? AND status IN ('intent','accepted','uncertain')", worker.id); }
  private uncertain(worker: WorkerRow, reason: string): void {
    this.store.run("UPDATE workers SET status='uncertain' WHERE id=?", worker.id);
    const task = this.store.task(worker.task);
    if (!['done', 'needs_human', 'cancelled'].includes(task.state)) transition(this.store, task.id, 'needs_human', reason);
    this.store.event('ownership', reason, worker.task, { worker: worker.id });
  }
  private meaningful(task: TaskRow): string {
    return hash({ diff: task.workspace ? this.workspaces.fingerprint(task.workspace) : '',
      evidence: this.store.all('SELECT id FROM evidence WHERE task=? AND valid=1 ORDER BY id', task.id),
      acknowledgements: this.store.all('SELECT id FROM messages WHERE recipient=? AND acknowledged IS NOT NULL ORDER BY id', task.id),
      dependencies: this.store.spec(task).dependencies.map(d => this.store.get('SELECT state,revision FROM tasks WHERE id=?', d.id)),
    });
  }
  private async retire(worker: WorkerRow, reason: string): Promise<boolean> {
    if (worker.status === 'stopped') return true;
    if (!worker.handle || await this.runtime.cancel(this.store.handle(worker)) !== 'stopped') { this.uncertain(worker, `cannot confirm worker stopped: ${reason}`); return false; }
    this.store.run("UPDATE workers SET status='stopped' WHERE id=?", worker.id);
    this.store.run('UPDATE attempts SET ended=?,reason=? WHERE task=? AND number=?', Date.now(), reason, worker.task, worker.attempt);
    this.store.event('worker-stop', reason, worker.task, { worker: worker.id, session: worker.session });
    return true;
  }
  private async reconcile(worker: WorkerRow): Promise<void> {
    if (!worker.handle || worker.status !== 'active') return;
    const handle = this.store.handle(worker), task = this.store.task(worker.task), spec = this.store.spec(task);
    if (!this.observed.has(worker.id)) {
      this.observed.add(worker.id);
      void this.runtime.observe(handle, () => { /* events are hints; the bounded poll reconciles durable status */ }, this.events.signal).catch(() => this.store.event('events', 'event stream lost; polling history remains authoritative', task.id));
    }
    if (task.leaseUntil && task.leaseUntil < Date.now()) {
      const owned = await this.runtime.resume(handle);
      if (owned !== 'owned') { this.uncertain(worker, `expired lease reconciliation: ${owned}`); return; }
      this.store.event('lease', 'expired lease reconciled to same live owner; no second writer', task.id);
    }
    const status = await this.runtime.status(handle);
    if (status.state === 'permission') {
      if (task.state !== 'needs_human' && task.state !== 'done') transition(this.store, task.id, 'needs_human', `pending permission ${status.permissionIds?.join(',') ?? ''}; operator review required`);
      return;
    }
    if (status.state === 'unavailable' || status.state === 'missing') { this.uncertain(worker, 'worker runtime unobservable; session/process reconciliation required'); return; }
    this.store.updateTask(task.id, { leaseUntil: Date.now() + this.policy.leaseMs });
    if (task.started && Date.now() - task.started > spec.limits.elapsedMs && task.state !== 'done') {
      await this.retire(worker, 'elapsed budget exhausted');
      if (this.store.task(task.id).state !== 'needs_human') transition(this.store, task.id, 'needs_human', 'elapsed budget exhausted'); return;
    }
    const pending = this.pending(worker);
    if (pending) {
      const history = await this.runtime.messages(handle);
      const accepted = history.find(m => m.id === pending.id && m.role === 'user');
      if (!accepted) {
        // No history after an ambiguous acceptance is NOT a safe negative acknowledgement.
        if (status.state === 'idle') { this.store.run("UPDATE dispatches SET status='uncertain' WHERE id=?", pending.id); this.uncertain(worker, 'prompt acceptance uncertain: recorded ID absent from idle session history'); }
        return;
      }
      if (pending.status !== 'accepted') this.store.run("UPDATE dispatches SET status='accepted' WHERE id=?", pending.id);
      if (status.state === 'busy') return;
      const replies = history.filter(m => m.role === 'assistant' && m.parent === pending.id);
      const final = replies.at(-1);
      if (!final?.complete) { this.uncertain(worker, 'idle session has no complete result for recorded prompt'); return; }
      const tokenUsage = replies.some(m => m.tokens === null) ? null : replies.reduce((sum, m) => sum + m.tokens!, 0);
      const monetary = replies.some(m => m.cost === null) ? null : replies.reduce((sum, m) => sum + m.cost!, 0);
      const nextProgress = this.meaningful(this.store.task(task.id));
      this.store.transaction(() => {
        this.store.run("UPDATE dispatches SET status='completed',result=? WHERE id=?", canonical({ message: final.id, error: final.error ?? null, tokens: tokenUsage, cost: monetary }), pending.id);
        this.store.updateTask(task.id, { noProgress: task.progress === nextProgress ? task.noProgress + 1 : 0, progress: nextProgress,
          tokens: tokenUsage === null ? null : (task.tokens ?? 0) + tokenUsage, cost: monetary === null ? null : (task.cost ?? 0) + monetary });
        this.store.event('turn', 'completed turn reconciled by request/parent identities', task.id, { prompt: pending.id, message: final.id, meaningfulProgress: task.progress !== nextProgress });
      });
      if (final.error) {
        const current = this.store.task(task.id);
        if (current.retries >= spec.limits.providerRetries) {
          await this.retire(worker, 'provider retry budget exhausted');
          if (current.state === 'running') transition(this.store, task.id, 'needs_human', 'provider errors exhausted bounded retries');
        } else {
          this.store.updateTask(task.id, { retries: current.retries + 1, nextRun: Date.now() + 1000 * 2 ** current.retries });
          this.store.event('retry', 'provider error: bounded exponential backoff before useful continuation', task.id, { error: redact(final.error, this.service.secrets) });
        }
      }
    }
    const current = this.store.task(task.id);
    if (status.state === 'idle' && current.state === 'submitted') await this.retire(worker, 'submitted result frozen for independent verification');
    if (status.state === 'idle' && worker.readOnly && !this.pending(worker)) {
      await this.retire(worker, 'bounded late responder turn finished');
      this.store.run("UPDATE actions SET status='finished' WHERE id=?", `responder_${worker.id}`);
    }
  }
  private dependencies(task: TaskRow): boolean { return this.store.spec(task).dependencies.every(d => { const row = this.store.task(d.id); return row.revision === d.revision && row.state === 'done'; }); }
  private activeCount(): number { return this.store.tasks().filter(t => t.state === 'running' || t.state === 'submitted').length + this.store.all<WorkerRow>("SELECT * FROM workers WHERE readOnly=1 AND status='active'").length; }
  private async claim(task: TaskRow, readOnly = false): Promise<WorkerRow | null> {
    const spec = this.store.spec(task), now = Date.now();
    if (!readOnly && task.attempt >= spec.limits.attempts) { transition(this.store, task.id, 'needs_human', 'attempt budget exhausted'); return null; }
    const workerId = uid('worker'), token = randomBytes(32).toString('hex');
    const claimed = this.store.transaction(() => {
      if (!readOnly && (this.store.task(task.id).state !== 'ready' || !task.approval || !this.dependencies(task))) return false;
      for (const key of spec.locks) {
        const held = this.store.get<{ task: string }>('SELECT task FROM resource_locks WHERE key=?', key);
        if (held && held.task !== task.id) return false;
      }
      for (const key of spec.locks) this.store.run('INSERT OR IGNORE INTO resource_locks VALUES (?,?)', key, task.id);
      this.store.run('INSERT INTO workers VALUES (?,?,?,?,?,?,?,?,?,?)', workerId, task.id, task.revision, readOnly ? task.attempt : task.attempt + 1, null, null, 'starting', hash(token), Number(readOnly), now);
      if (!readOnly) {
        transition(this.store, task.id, 'running', 'atomic claim: approved revision, dependencies, capacity and named locks satisfied');
        this.store.updateTask(task.id, { worker: workerId, attempt: task.attempt + 1, started: task.started ?? now, leaseUntil: now + this.policy.leaseMs });
        this.store.run('INSERT INTO attempts VALUES (?,?,?,?,?,?,?)', task.id, task.attempt + 1, workerId, task.baseCommit, now, null, null);
      }
      return true;
    });
    if (!claimed) return null;
    try {
      const workspace = readOnly ? this.workspaces.candidate(this.store.submission(task)?.commit ?? task.baseCommit, 'responder') : task.workspace ?? this.workspaces.create(task.id, task.baseCommit, task.attempt + 1);
      if (!readOnly) this.store.updateTask(task.id, { workspace });
      this.service.secrets.push(token);
      const handle = await this.runtime.start({ id: workerId, directory: workspace, task: spec, policy: this.store.policy(task), controlUrl: this.service.url, token, readOnly });
      this.store.run("UPDATE workers SET session=?,handle=?,status='active' WHERE id=?", handle.session, canonical(handle), workerId);
      if (readOnly) this.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', `responder_${workerId}`, task.id, 'responder', 'running', canonical({ messages: this.service.readMail(task.id).map(m => m.id) }), null, now);
      return this.store.worker(workerId);
    } catch (error) {
      this.uncertain(this.store.worker(workerId), `start failed; reconcile process metadata before retry: ${redact(errorText(error), this.service.secrets)}`);
      return null;
    }
  }
  private async prompt(worker: WorkerRow): Promise<void> {
    if (this.pending(worker)) return;
    const task = this.store.task(worker.task), spec = this.store.spec(task), handle = this.store.handle(worker);
    if (task.nextRun > Date.now()) return;
    if (!worker.readOnly && (task.prompts >= spec.limits.prompts || task.noProgress >= spec.limits.noProgress || (task.tokens ?? 0) >= spec.limits.tokens || (task.cost ?? 0) >= spec.limits.costUsd)) {
      await this.retire(worker, 'prompt/progress/consumption budget exhausted');
      if (this.store.task(task.id).state !== 'needs_human') transition(this.store, task.id, 'needs_human', 'finite prompt, no-progress or consumption budget exhausted'); return;
    }
    const count = this.store.get<{ count: number }>('SELECT count(*) count FROM dispatches WHERE worker=?', worker.id)!.count;
    if (!worker.readOnly && count >= spec.limits.sessionPrompts) {
      if (await this.retire(worker, 'session context rotation')) { transition(this.store, task.id, 'ready', 'create replacement session with authoritative context and preserved diff'); this.store.updateTask(task.id, { worker: null }); }
      return;
    }
    const messageId = `msg_${randomBytes(16).toString('hex')}`;
    const mail = this.service.readMail(task.id);
    const prompt = `${worker.readOnly ? 'READ-ONLY RESPONDER: answer the addressed late questions in one turn. Do not reopen implementation, edit files or submit.' : 'Perform the next concrete unit of approved work. Inspect the current diff and run relevant checks; resolve pending messages before editing shared interfaces. Submit with harness_submit only after all acceptance criteria are evidenced; otherwise checkpoint or declare a blocker.'}\n${JSON.stringify(this.service.context(worker))}\nRemaining acceptance criteria (not independently verified yet): ${JSON.stringify(spec.acceptance)}\nPrompt budget used: ${task.prompts}/${spec.limits.prompts}; limits ${JSON.stringify(spec.limits)}. Never infer completion from a final assistant message.`;
    this.store.transaction(() => {
      this.store.run('INSERT INTO dispatches VALUES (?,?,?,?,?,?,?)', messageId, worker.id, handle.session, 'intent', redact(prompt, this.service.secrets), Date.now(), null);
      if (!worker.readOnly) this.store.updateTask(task.id, { prompts: task.prompts + 1, progress: this.meaningful(task) });
      this.store.event('dispatch', 'single in-flight prompt intent persisted before external dispatch', task.id, { worker: worker.id, session: handle.session, messageId });
    });
    let outcome: 'accepted' | 'rejected' | 'uncertain';
    try { outcome = await this.runtime.dispatch(handle, messageId, prompt); } catch { outcome = 'uncertain'; }
    this.store.run('UPDATE dispatches SET status=? WHERE id=?', outcome, messageId);
    if (outcome === 'accepted') this.service.delivered(task.id, mail.map(m => m.id));
    else if (outcome === 'rejected') {
      this.store.updateTask(task.id, { nextRun: Date.now() + 1000 * 2 ** task.retries, retries: task.retries + 1 });
      if (task.retries >= spec.limits.providerRetries) { await this.retire(worker, 'dispatch rejected repeatedly'); if (task.state === 'running') transition(this.store, task.id, 'needs_human', 'provider unavailable/rejected; bounded retries exhausted'); }
    }
  }
  private cycles(): void {
    const tasks = this.store.tasks(), waiting = new Map(tasks.filter(t => t.state === 'blocked' && t.waitingFor).map(t => [t.id, t.waitingFor!]));
    for (const start of waiting.keys()) {
      const chain = new Set<string>(); let cursor: string | undefined = start;
      while (cursor) {
        if (chain.has(cursor)) { for (const task of chain) if (this.store.task(task).state === 'blocked') transition(this.store, task, 'needs_human', `unresolved message/dependency cycle: ${[...chain].join(' -> ')}`); break; }
        chain.add(cursor);
        const next = waiting.get(cursor);
        if (next) { const responder = this.store.task(next); if (this.store.spec(responder).dependencies.some(d => chain.has(d.id) && this.store.task(d.id).state !== 'done')) { transition(this.store, start, 'needs_human', 'responder depends on waiting task; message/dependency cycle'); break; } }
        cursor = next;
      }
    }
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE status='active'")) {
        try { await this.reconcile(worker); } catch (error) { this.uncertain(worker, `reconciliation failed: ${redact(errorText(error), this.service.secrets)}`); }
      }
      this.cycles();
      const mode = this.store.meta('mode', 'stopped');
      if (mode !== 'running') return;
      for (const task of this.store.tasks()) {
        if (this.store.meta(`milestone:${task.milestone}`, 'paused') !== 'active') continue;
        if (task.state === 'blocked' && this.service.readMail(task.id).some(m => ['answer', 'decision', 'evidence'].includes(m.type)) && this.activeCount() < this.policy.resources.implementations) {
          const worker = task.worker ? this.store.worker(task.worker) : null;
          if (worker?.status === 'active' && (await this.runtime.status(this.store.handle(worker))).state === 'idle' && !this.pending(worker)) {
            transition(this.store, task.id, 'running', 'addressed reply woke idle blocked owner; capacity reacquired'); this.store.updateTask(task.id, { waitingFor: null });
          }
        }
        const current = this.store.task(task.id);
        if (current.state === 'ready' && current.approval && this.dependencies(current) && current.nextRun <= Date.now() && this.activeCount() < this.policy.resources.implementations && !this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped'", current.id)) await this.claim(current);
        const running = this.store.task(task.id);
        if (running.state === 'running' && running.worker) {
          const worker = this.store.worker(running.worker);
          if (worker.status === 'active' && (await this.runtime.status(this.store.handle(worker))).state === 'idle') await this.prompt(worker);
        }
        if (current.state === 'done' && this.service.readMail(current.id).length && this.activeCount() < this.policy.resources.implementations && !this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped'", current.id)) {
          const responded = this.store.all<ActionRow>("SELECT * FROM actions WHERE task=? AND kind='responder'", current.id).flatMap(a => (JSON.parse(a.data) as { messages: string[] }).messages);
          if (this.service.readMail(current.id).some(m => !responded.includes(m.id))) { const responder = await this.claim(current, true); if (responder) await this.prompt(responder); }
        }
        if (current.state === 'submitted' && !this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped' AND readOnly=0", current.id) && !this.verification.has(current.id) && this.verification.size < this.policy.resources.verification) {
          const promise = this.verifier.verify(current.id).then(() => {}).catch(error => this.store.event('verification-error', errorText(error), current.id)).finally(() => this.verification.delete(current.id));
          this.verification.set(current.id, promise);
        }
      }
      if (!this.integrating) {
        const task = this.store.tasks().find(t => t.state === 'integration' && this.store.meta(`milestone:${t.milestone}`, 'paused') === 'active');
        if (task) this.integrating = this.integrator.integrate(task.id).then(() => {}).catch(error => { this.store.event('integration-error', errorText(error), task.id); this.store.setMeta('mode', 'paused'); }).finally(() => { this.integrating = null; });
      }
      for (const task of this.store.tasks().filter(t => ['done', 'failed', 'cancelled'].includes(t.state))) if (!this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped'", task.id)) this.store.run('DELETE FROM resource_locks WHERE task=?', task.id);
    } finally { this.ticking = false; }
  }
  async control(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
    const scope = z.object({ milestone: z.string().optional() }).strict();
    if (['pause', 'resume', 'drain', 'stop'].includes(action)) {
      const { milestone } = scope.parse(input);
      if (milestone) this.store.setMeta(`milestone:${milestone}`, action === 'resume' ? 'active' : 'paused');
      else this.store.setMeta('mode', { pause: 'paused', resume: 'running', drain: 'draining', stop: 'stopped' }[action]);
      this.store.event('control', `operator ${action}`, null, { milestone: milestone ?? null });
      if (action === 'stop') await this.stopWorkers(milestone);
      return { mode: this.store.meta('mode', 'stopped') };
    }
    if (action === 'cancel') {
      const { task } = z.object({ task: z.string() }).strict().parse(input);
      for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE task=? AND status!='stopped'", task)) if (!await this.retire(worker, 'operator cancellation')) return { state: 'needs_human' };
      this.store.run("UPDATE dispatches SET status='cancelled' WHERE worker IN (SELECT id FROM workers WHERE task=?) AND status IN ('intent','accepted','uncertain')", task);
      transition(this.store, task, 'cancelled', 'operator cancelled; owned workers stopped; unfinished checkout preserved'); return { state: 'cancelled' };
    }
    if (action === 'retry') {
      const { task, reason } = z.object({ task: z.string(), reason: z.string().min(1) }).strict().parse(input);
      if (this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped'", task) || this.store.get("SELECT id FROM actions WHERE task=? AND status IN ('intent','running','uncertain')", task)) throw new Error('reconcile/stop prior owners and actions before retry');
      transition(this.store, task, 'ready', `operator retry within existing limits: ${reason}`); this.store.updateTask(task, { worker: null }); return { state: 'ready' };
    }
    throw new Error(`unknown supervisor control ${action}`);
  }
  async stopWorkers(milestone?: string): Promise<void> {
    this.verifier.runner.stop();
    for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE status!='stopped'")) {
      const task = this.store.task(worker.task); if (milestone && task.milestone !== milestone) continue;
      if (await this.retire(worker, 'controlled stop; preserve unfinished work')) {
        this.store.run("UPDATE dispatches SET status='cancelled' WHERE worker=? AND status IN ('intent','accepted','uncertain')", worker.id);
        if (['running', 'blocked'].includes(task.state)) { transition(this.store, task.id, 'ready', 'controlled stop confirmed; resume requires explicit operator action'); this.store.updateTask(task.id, { worker: null }); }
      }
    }
    await Promise.all([...this.verification.values(), ...(this.integrating ? [this.integrating] : [])]);
  }
  async run(maxMs = 3_600_000): Promise<void> {
    const end = Date.now() + maxMs;
    try {
      await this.recover();
      while (Date.now() < end && this.store.meta('mode', 'stopped') !== 'stopped') {
        await this.tick();
        const tasks = this.store.tasks();
        if (tasks.every(t => ['draft', 'done', 'cancelled', 'failed'].includes(t.state)) && !this.verification.size && !this.integrating) { this.store.event('milestone', 'approved work exhausted; no new scope invented'); break; }
        if (this.store.meta('mode', '') === 'draining' && this.store.all<DispatchRow>("SELECT * FROM dispatches WHERE status IN ('intent','accepted','uncertain')").length === 0 && !this.verification.size && !this.integrating) break;
        await sleep(this.policy.pollMs);
      }
    } finally { this.store.setMeta('mode', 'stopped'); this.events.abort(); await this.stopWorkers(); }
  }
}
