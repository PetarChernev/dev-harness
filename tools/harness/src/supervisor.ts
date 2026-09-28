import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { WorkerRuntime, WorkerHandle } from './runtime.js';
import { WorkerStartError } from './runtime.js';
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
  private deadline = Number.POSITIVE_INFINITY;
  constructor(readonly store: Store, readonly service: StateService, readonly workspaces: Workspaces,
    readonly runtime: WorkerRuntime, readonly policy: Project, readonly verifier: Verifier, readonly integrator: Integrator) {}

  async recover(): Promise<void> {
    this.store.run("UPDATE actions SET status='cancelled' WHERE kind='command' AND status='queued'");
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
      if (!worker.handle) {
        const launch = await this.runtime.reconcileStart?.(worker.id);
        if (launch?.handle) { worker.handle = canonical(launch.handle); worker.session = launch.handle.session; this.store.run('UPDATE workers SET handle=?,session=?,status=? WHERE id=?', worker.handle, worker.session, launch.state === 'owned' ? 'active' : launch.state, worker.id); }
        else if (launch?.state === 'stopped') { this.store.run("UPDATE workers SET status='stopped' WHERE id=?", worker.id); const task = this.store.task(worker.task); if (task.state === 'running') { transition(this.store, task.id, 'ready', 'interrupted launch process confirmed stopped before dispatch'); this.store.updateTask(task.id, { worker: null }); } continue; }
        else { this.uncertain(worker, 'worker launch outcome uncertain; inspect owned process record'); continue; }
      }
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
    if (!worker.readOnly) this.verifier.runner.cancelTask(worker.task);
    if (!worker.handle || await this.runtime.cancel(this.store.handle(worker)) !== 'stopped') { this.uncertain(worker, `cannot confirm worker stopped: ${reason}`); return false; }
    this.store.run("UPDATE workers SET status='stopped' WHERE id=?", worker.id);
    this.store.run("UPDATE dispatches SET status='cancelled' WHERE worker=? AND status IN ('intent','accepted','uncertain')", worker.id);
    if (!worker.readOnly) this.store.run('UPDATE attempts SET ended=?,reason=? WHERE task=? AND revision=? AND number=?', Date.now(), reason, worker.task, worker.revision, worker.attempt);
    this.store.event('worker-stop', reason, worker.task, { worker: worker.id, session: worker.session });
    return true;
  }
  private async reconcile(worker: WorkerRow): Promise<void> {
    if (!worker.handle || worker.status !== 'active') return;
    const handle = this.store.handle(worker), task = this.store.task(worker.task), spec = this.store.spec(task);
    if (worker.readOnly && Date.now() - worker.created > Math.min(spec.limits.elapsedMs, 60_000)) { await this.retire(worker, 'late responder wall-clock budget exhausted'); return; }
    if (!this.observed.has(worker.id)) {
      this.observed.add(worker.id);
      void this.runtime.observe(handle, () => { /* events are hints; the bounded poll reconciles durable status */ }, this.events.signal).catch(() => this.store.event('events', 'event stream lost; polling history remains authoritative', task.id));
    }
    if (task.leaseUntil && task.leaseUntil < Date.now()) {
      const owned = await this.runtime.resume(handle);
      if (owned !== 'owned') { this.uncertain(worker, `expired lease reconciliation: ${owned}`); return; }
      this.store.updateTask(task.id, { leaseUntil: Date.now() + this.policy.leaseMs });
      this.store.event('lease', 'expired lease reconciled to same live owner; no second writer', task.id);
    }
    if (task.started && Date.now() - task.started > spec.limits.elapsedMs && task.state !== 'done') {
      await this.retire(worker, 'elapsed budget exhausted');
      if (this.store.task(task.id).state !== 'needs_human') transition(this.store, task.id, 'needs_human', 'elapsed budget exhausted');
      else this.store.updateTask(task.id, { blocker: 'elapsed budget exhausted; owned worker stopped or awaiting ownership reconciliation' });
      return;
    }
    const status = await this.runtime.status(handle);
    if (status.retryAttempt !== undefined) {
      if (status.retryAttempt > spec.limits.providerRetries) { await this.retire(worker, 'OpenCode internal provider retry cap exceeded'); if (this.store.task(task.id).state !== 'needs_human') transition(this.store, task.id, 'needs_human', 'provider retry budget exhausted inside runtime'); return; }
      if (this.store.meta(`provider-retry:${worker.id}`, -1) !== status.retryAttempt) { this.store.setMeta(`provider-retry:${worker.id}`, status.retryAttempt); this.store.event('retry', 'OpenCode provider backoff observed; no competing harness prompt', task.id, { attempt: status.retryAttempt, next: status.nextRetryAt }); }
    }
    if (status.state === 'permission') {
      if (task.state !== 'needs_human' && task.state !== 'done') transition(this.store, task.id, 'needs_human', `pending permission ${status.permissionIds?.join(',') ?? ''}; operator review required`);
      return;
    }
    if (status.state === 'unavailable' || status.state === 'missing') { this.uncertain(worker, 'worker runtime unobservable; session/process reconciliation required'); return; }
    this.store.updateTask(task.id, { leaseUntil: Date.now() + this.policy.leaseMs });
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
        if (worker.readOnly) { this.store.run('UPDATE actions SET result=? WHERE id=?', canonical({ session: worker.session, tokens: tokenUsage, cost: monetary, error: final.error ?? null }), `responder_${worker.id}`); this.store.event('turn', 'bounded read-only responder result reconciled', task.id, { worker: worker.id, message: final.id }); return; }
        const trackedCommand = this.store.get("SELECT id FROM actions WHERE task=? AND kind='command' AND status IN ('queued','intent','running')", task.id);
        const usage = this.store.all<{ result: string | null }>("SELECT d.result FROM dispatches d JOIN workers w ON w.id=d.worker WHERE w.task=? AND w.revision=? AND w.readOnly=0 AND d.status IN ('completed','cancelled')", task.id, task.revision).map(row => row.result ? JSON.parse(row.result) as { tokens: number | null; cost: number | null } : { tokens: null, cost: null });
        const knownTokens = usage.reduce((sum, row) => sum + (row.tokens ?? 0), 0), knownCost = usage.reduce((sum, row) => sum + (row.cost ?? 0), 0);
        this.store.setMeta(`usage:${task.id}@${task.revision}`, { knownTokens, knownCost });
        this.store.updateTask(task.id, { noProgress: trackedCommand ? task.noProgress : task.progress === nextProgress ? task.noProgress + 1 : 0, progress: nextProgress,
          tokens: usage.some(row => row.tokens === null) ? null : knownTokens, cost: usage.some(row => row.cost === null) ? null : knownCost });
        this.store.event('turn', 'completed turn reconciled by request/parent identities', task.id, { prompt: pending.id, message: final.id, meaningfulProgress: task.progress !== nextProgress });
        const consumed = this.store.task(task.id);
        if (knownTokens > spec.limits.tokens || knownCost > spec.limits.costUsd) this.store.event('budget', 'in-flight usage exceeded last-observed allowance; no further prompts authorized', task.id, { tokens: consumed.tokens, costUsd: consumed.cost, knownTokens, knownCost, limits: spec.limits });
      });
      if (final.error && !worker.readOnly) {
        const current = this.store.task(task.id);
        if (current.retries >= spec.limits.providerRetries) {
          await this.retire(worker, 'provider retry budget exhausted');
          if (current.state === 'running') transition(this.store, task.id, 'needs_human', 'provider errors exhausted bounded retries');
        } else {
          this.store.updateTask(task.id, { retries: current.retries + 1, nextRun: Date.now() + 1000 * 2 ** current.retries });
          this.store.event('retry', 'provider error: bounded exponential backoff before useful continuation', task.id, { error: redact(final.error, this.service.secrets) });
        }
      }
      const checkpoint = this.store.get<{ body: string }>('SELECT body FROM checkpoints WHERE worker=? AND created>=? ORDER BY created DESC LIMIT 1', worker.id, pending.created);
      const outcome = checkpoint ? (JSON.parse(checkpoint.body) as { outcome?: string }).outcome : null;
      if (outcome === 'replace_session' && this.store.task(task.id).state === 'running' && await this.retire(worker, 'worker requested fresh context at a safe boundary')) {
        transition(this.store, task.id, 'ready', 'rehydrate replacement session from spec/diff/evidence/mail'); this.store.updateTask(task.id, { worker: null });
      } else if (outcome === 'recoverable_failure' && this.store.task(task.id).state === 'running') {
        const current = this.store.task(task.id);
        if (current.retries >= spec.limits.providerRetries) { await this.retire(worker, 'recoverable retry budget exhausted'); transition(this.store, task.id, 'needs_human', 'recoverable failure retry budget exhausted'); }
        else { this.store.updateTask(task.id, { retries: current.retries + 1, nextRun: Date.now() + 1000 * 2 ** current.retries }); this.store.event('retry', 'structured recoverable result; bounded backoff without changing criteria', task.id); }
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
  private activeCount(): number { return this.store.tasks().filter(t => t.state === 'running' || t.state === 'submitted').length + this.store.all<WorkerRow>("SELECT * FROM workers WHERE (readOnly=1 AND status IN ('active','uncertain')) OR (readOnly=0 AND status='uncertain')").length; }
  private async claim(task: TaskRow, readOnly = false): Promise<WorkerRow | null> {
    const spec = this.store.spec(task), now = Date.now();
    if (!readOnly && task.attempt >= spec.limits.attempts) { transition(this.store, task.id, 'needs_human', 'attempt budget exhausted'); return null; }
    const workerId = uid('worker'), token = randomBytes(32).toString('hex');
    let base = task.baseCommit;
    if (!readOnly && !task.workspace && spec.dependencies.length) {
      base = this.workspaces.integrationHead(this.store.policy(task), task.baseCommit);
      // A newly unblocked dependency task starts from the exact integrated result, not its pre-dependency plan base.
      for (const dependency of spec.dependencies) {
        const integrated = this.store.get<{ candidate: string }>("SELECT candidate FROM integrations WHERE task=? AND revision=? AND state='advanced' ORDER BY created DESC LIMIT 1", dependency.id, dependency.revision);
        if (!integrated) throw new Error('dependency completion lacks integrated immutable evidence');
        this.workspaces.ancestor(integrated.candidate, base);
      }
      this.workspaces.ancestor(task.baseCommit, base);
    }
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
        this.store.updateTask(task.id, { worker: workerId, attempt: task.attempt + 1, started: task.started ?? now, leaseUntil: now + this.policy.leaseMs, baseCommit: base });
        this.store.run('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?)', task.id, task.revision, task.attempt + 1, workerId, base, now, null, null);
        this.store.event('base', 'explicit claim base includes completed dependency integration', task.id, { planned: task.baseCommit, actual: base });
      }
      return true;
    });
    if (!claimed) return null;
    try {
      const workspace = readOnly ? this.workspaces.candidate(this.store.submission(task)?.commit ?? task.baseCommit, 'responder') : task.workspace ?? this.workspaces.create(task.id, base, task.attempt + 1, task.revision);
      if (!readOnly) this.store.updateTask(task.id, { workspace });
      this.service.secrets.push(token);
      const handle = await this.runtime.start({ id: workerId, directory: workspace, task: spec, policy: this.store.policy(task), controlUrl: this.service.url, token, readOnly });
      this.store.run("UPDATE workers SET session=?,handle=?,status='active' WHERE id=?", handle.session, canonical(handle), workerId);
      if (readOnly) this.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', `responder_${workerId}`, task.id, 'responder', 'running', canonical({ messages: this.service.readMail(task.id).map(m => m.id) }), null, now);
      return this.store.worker(workerId);
    } catch (error) {
      if (error instanceof WorkerStartError && error.stopped) {
        this.store.run("UPDATE workers SET status='stopped' WHERE id=?", workerId);
        if (!readOnly) transition(this.store, task.id, 'needs_human', `worker startup blocked (owned process stopped): ${redact(error.message, this.service.secrets)}`);
      } else this.uncertain(this.store.worker(workerId), `start failed; reconcile process metadata before retry: ${redact(errorText(error), this.service.secrets)}`);
      return null;
    }
  }
  private async prompt(worker: WorkerRow): Promise<void> {
    if (this.pending(worker)) return;
    const task = this.store.task(worker.task), spec = this.store.spec(task), handle = this.store.handle(worker);
    if (Date.now() >= this.deadline) return;
    if (this.store.meta('mode', 'stopped') !== 'running' || this.store.meta(`milestone:${task.milestone}`, 'paused') !== 'active') return;
    if (this.store.get("SELECT id FROM actions WHERE task=? AND kind='command' AND status IN ('queued','intent','running','uncertain')", task.id)) return;
    if (task.nextRun > Date.now()) return;
    const usage = this.store.meta(`usage:${task.id}@${task.revision}`, { knownTokens: task.tokens ?? 0, knownCost: task.cost ?? 0 });
    if (!worker.readOnly && (task.prompts >= spec.limits.prompts || task.noProgress >= spec.limits.noProgress || usage.knownTokens >= spec.limits.tokens || usage.knownCost >= spec.limits.costUsd)) {
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
    if (this.store.worker(worker.id).status !== 'active') { this.store.run("UPDATE dispatches SET status='cancelled' WHERE id=?", messageId); return; }
    this.store.run("UPDATE dispatches SET status=? WHERE id=? AND status!='cancelled'", outcome, messageId);
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
        if (next) {
          const responder = this.store.task(next), spec = this.store.spec(responder);
          if (spec.dependencies.some(d => chain.has(d.id) && this.store.task(d.id).state !== 'done')) { transition(this.store, start, 'needs_human', 'responder depends on waiting task; message/dependency cycle'); break; }
          if (responder.state === 'ready' && spec.locks.some(key => { const lock = this.store.get<{ task: string }>('SELECT task FROM resource_locks WHERE key=?', key); return lock && chain.has(lock.task); })) { transition(this.store, start, 'needs_human', 'responder waits for a named lock held by waiting sender; message/lock cycle'); break; }
        }
        cursor = next;
      }
    }
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE status='active' AND readOnly IN (0,1)")) {
        try { await this.reconcile(worker); } catch (error) { this.uncertain(worker, `reconciliation failed: ${redact(errorText(error), this.service.secrets)}`); }
      }
      this.cycles();
      if (Date.now() >= this.deadline) { this.store.setMeta('mode', 'stopped'); return; }
      const mode = this.store.meta('mode', 'stopped');
      if (mode !== 'running') return;
      for (const task of this.store.tasks()) {
        if (Date.now() >= this.deadline) { this.store.setMeta('mode', 'stopped'); return; }
        if (task.state === 'ready') {
          const reason = this.store.meta(`milestone:${task.milestone}`, 'paused') !== 'active' ? 'milestone paused' : !task.approval ? 'approval required' : !this.dependencies(task) ? 'waiting on exact dependency revisions' : task.nextRun > Date.now() ? 'retry backoff' : this.activeCount() >= this.policy.resources.implementations ? 'implementation capacity occupied' : this.store.spec(task).locks.some(key => { const row = this.store.get<{ task: string }>('SELECT task FROM resource_locks WHERE key=?', key); return row && row.task !== task.id; }) ? 'named exclusive lock occupied' : 'eligible for atomic claim';
          if (this.store.meta(`schedule:${task.id}`, '') !== reason) { this.store.event('scheduling', reason, task.id); this.store.setMeta(`schedule:${task.id}`, reason); }
        }
        if (this.store.meta(`milestone:${task.milestone}`, 'paused') !== 'active') continue;
        if ((task.state === 'blocked' || (task.state === 'needs_human' && task.waitingFor === 'operator')) && this.service.readMail(task.id).some(m => task.waitingFor === 'operator' ? m.sender === 'operator' && m.type === 'answer' : ['answer', 'decision', 'evidence'].includes(m.type)) && this.activeCount() < this.policy.resources.implementations) {
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
        if (current.state === 'submitted' && !this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped' AND readOnly=0", current.id) && !this.verification.has(current.id) && this.verification.size + Number(Boolean(this.integrating)) < this.policy.resources.verification) {
          const promise = this.verifier.verify(current.id).then(() => {}).catch(error => this.store.event('verification-error', errorText(error), current.id)).finally(() => this.verification.delete(current.id));
          this.verification.set(current.id, promise);
        }
      }
      if (!this.integrating && this.verification.size < this.policy.resources.verification) {
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
    if (action === 'cancel' || action === 'fail') {
      const { task, reason } = z.object({ task: z.string(), reason: z.string().min(1).optional() }).strict().parse(input);
      if (action === 'fail' && !reason) throw new Error('failure requires an operator reason');
      this.verifier.runner.cancelTask(task);
      for (const worker of this.store.all<WorkerRow>("SELECT * FROM workers WHERE task=? AND status!='stopped'", task)) if (!await this.retire(worker, 'operator cancellation')) return { state: 'needs_human' };
      this.store.run("UPDATE dispatches SET status='cancelled' WHERE worker IN (SELECT id FROM workers WHERE task=?) AND status IN ('intent','accepted','uncertain')", task);
      this.store.run("UPDATE integrations SET state='failed' WHERE task=? AND state IN ('prepared','created','checked')", task);
      const state = action === 'cancel' ? 'cancelled' : 'failed';
      transition(this.store, task, state, `${reason ?? 'operator cancelled'}; owned workers stopped; unfinished checkout preserved`); return { state };
    }
    if (action === 'retry') {
      const { task, reason } = z.object({ task: z.string(), reason: z.string().min(1) }).strict().parse(input);
      if (!this.store.task(task).approval || !['failed', 'cancelled', 'needs_human', 'blocked'].includes(this.store.task(task).state)) throw new Error('retry requires approved failed/cancelled/blocked work');
      if (this.store.get("SELECT id FROM workers WHERE task=? AND status!='stopped'", task) || this.store.get("SELECT id FROM actions WHERE task=? AND status IN ('intent','running','uncertain')", task)) throw new Error('reconcile/stop prior owners and actions before retry');
      transition(this.store, task, 'ready', `operator retry within existing limits: ${reason}`); this.store.updateTask(task, { worker: null }); return { state: 'ready' };
    }
    if (action === 'reconcile-worker') {
      const { worker: workerId, reason } = z.object({ worker: z.string(), reason: z.string().min(1) }).strict().parse(input);
      const worker = this.store.worker(workerId);
      if (!worker.handle) {
        const launch = await this.runtime.reconcileStart?.(worker.id);
        if (launch?.handle) { worker.handle = canonical(launch.handle); worker.session = launch.handle.session; this.store.run('UPDATE workers SET handle=?,session=? WHERE id=?', worker.handle, worker.session, worker.id); }
        else if (launch?.state === 'stopped') this.store.run("UPDATE workers SET status='stopped' WHERE id=?", worker.id);
        else throw new Error('ownership still uncertain; inspect/terminate the recorded owned process before reconciliation');
      }
      if (worker.handle && !await this.retire(worker, `operator reconciliation: ${reason}`)) throw new Error('cannot confirm owned worker termination');
      this.store.run("UPDATE dispatches SET status='cancelled' WHERE worker=? AND status IN ('intent','accepted','uncertain')", worker.id);
      this.store.event('reconciliation', reason, worker.task, { worker: worker.id, result: 'confirmed stopped; inspect external actions before retry' }); return { worker: worker.id, state: 'stopped', next: 'resolve uncertain external actions, then explicit retry within remaining limits' };
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
    await this.verifier.runner.drain();
  }
  async run(maxMs = 3_600_000, exitOnBlocked = false): Promise<void> {
    const end = Date.now() + maxMs;
    this.deadline = end;
    try {
      await this.recover();
      while (Date.now() < end && this.store.meta('mode', 'stopped') !== 'stopped') {
        await this.tick();
        const tasks = this.store.tasks();
        if (exitOnBlocked && tasks.every(t => ['needs_human', 'failed', 'done', 'cancelled'].includes(t.state)) && !this.verification.size && !this.integrating) break;
        if (tasks.every(t => ['draft', 'done', 'cancelled', 'failed'].includes(t.state)) && !this.verification.size && !this.integrating) { this.store.event('milestone', 'approved work exhausted; no new scope invented'); break; }
        if (this.store.meta('mode', '') === 'draining' && this.store.all<DispatchRow>("SELECT * FROM dispatches WHERE status IN ('intent','accepted','uncertain')").length === 0 && !this.verification.size && !this.integrating) break;
        await sleep(this.policy.pollMs);
      }
    } finally { this.store.setMeta('mode', 'stopped'); this.events.abort(); await this.stopWorkers(); }
  }
}
