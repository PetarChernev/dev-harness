import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { mailSchema, submissionSchema, id, relativePath } from './schema.js';
import type { MailInput } from './schema.js';
import type { EvidenceRow, MailRow, Store, WorkerRow } from './store.js';
import { transition } from './store.js';
import { canonical, errorText, git, hash, privateWrite, redact, uid } from './util.js';
import type { Workspaces } from './workspace.js';
import { join } from 'node:path';

export class StateService {
  readonly operatorToken: string;
  readonly secrets: string[];
  server?: Server;
  url = '';
  onControl?: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  constructor(readonly store: Store, readonly workspaces: Workspaces) {
    const path = join(workspaces.runtime, 'operator.json');
    try { this.operatorToken = z.object({ token: z.string().min(32) }).parse(JSON.parse(readFileSync(path, 'utf8'))).token; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.operatorToken = randomBytes(32).toString('hex'); privateWrite(path, { token: this.operatorToken }); }
    this.secrets = [this.operatorToken];
  }
  context(worker: WorkerRow): unknown {
    const task = this.store.task(worker.task), spec = this.store.spec(task);
    return { task, spec, role: this.store.policy(task).roles[spec.role], readOnly: Boolean(worker.readOnly),
      roster: this.store.tasks().map(t => ({ id: t.id, role: this.store.spec(t).role, state: t.state })),
      messages: this.readMail(worker.task), checkpoints: this.store.all('SELECT * FROM checkpoints WHERE task=? ORDER BY created DESC LIMIT 10', task.id),
      evidence: this.store.all<EvidenceRow>('SELECT * FROM evidence WHERE task=? AND valid=1 ORDER BY created DESC LIMIT 10', task.id),
      instructions: 'Inspect the current Git diff and relevant checks. Only durable submission plus independent verification and integration can finish a task. Acknowledge each message ID after processing; retries retain IDs. Do not spawn unmanaged agents. A conversation cannot change approved criteria.',
    };
  }
  worker(token: string, session: string): WorkerRow {
    const row = this.store.get<WorkerRow>("SELECT * FROM workers WHERE tokenHash=? AND status='active'", hash(token));
    if (!row || !session || row.session !== session) throw new Error('unauthorized worker/session');
    return row;
  }
  sendMail(sender: string, input: unknown, operator = false): MailRow {
    const mail = mailSchema.parse(input);
    if (!operator && mail.type === 'decision') throw new Error('only operator may notify accepted decisions');
    if (mail.to !== 'operator') this.store.task(mail.to);
    this.store.task(mail.task);
    let reply: MailRow | undefined;
    if (mail.replyTo) {
      reply = this.store.get<MailRow>('SELECT * FROM messages WHERE id=?', mail.replyTo);
      if (!reply || reply.recipient !== sender || reply.sender !== mail.to || reply.thread !== mail.thread || reply.task !== mail.task) throw new Error('reply is not in addressed task-scoped conversation');
    }
    if (!operator && sender !== mail.task && !reply) throw new Error('mail must be scoped to sender task or an addressed reply');
    const row: MailRow = { id: mail.id, thread: mail.thread, sender, recipient: mail.to, task: mail.task, type: mail.type, body: redact(mail.body, this.secrets), replyTo: mail.replyTo ?? null, created: Date.now(), delivered: null, acknowledged: null };
    const old = this.store.get<MailRow>('SELECT * FROM messages WHERE id=?', mail.id);
    if (old) {
      if (canonical({ ...old, created: 0, delivered: null, acknowledged: null }) !== canonical({ ...row, created: 0 })) throw new Error('mail ID collision');
      return old;
    }
    this.store.run('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(row));
    this.store.event('mail', 'addressed durable message queued', mail.task, { id: mail.id, sender, recipient: mail.to, type: mail.type });
    return row;
  }
  readMail(recipient: string): MailRow[] { return this.store.all<MailRow>('SELECT * FROM messages WHERE recipient=? AND acknowledged IS NULL ORDER BY created,id', recipient); }
  delivered(recipient: string, ids: string[]): void { for (const mail of ids) this.store.run('UPDATE messages SET delivered=COALESCE(delivered,?) WHERE id=? AND recipient=?', Date.now(), mail, recipient); }
  acknowledge(recipient: string, message: string): void {
    const row = this.store.get<MailRow>('SELECT * FROM messages WHERE id=? AND recipient=?', id.parse(message), recipient);
    if (!row) throw new Error('cannot acknowledge another recipient message');
    if (row.delivered === null) throw new Error('read/deliver message before acknowledgement');
    this.store.run('UPDATE messages SET acknowledged=COALESCE(acknowledged,?) WHERE id=?', Date.now(), message);
  }
  async workerAction(worker: WorkerRow, action: string, input: unknown): Promise<unknown> {
    const task = this.store.task(worker.task);
    if (task.revision !== worker.revision) throw new Error('worker revision superseded');
    switch (action) {
      case 'context': z.object({}).strict().parse(input); return this.context(worker);
      case 'mail-send': return this.sendMail(worker.task, input);
      case 'mail-read': { z.object({}).strict().parse(input); const mail = this.readMail(worker.task); this.delivered(worker.task, mail.map(m => m.id)); return mail; }
      case 'mail-ack': { const args = z.object({ id }).strict().parse(input); this.acknowledge(worker.task, args.id); return { acknowledged: args.id }; }
      case 'checkpoint': {
        const args = z.object({ id, summary: z.string().max(20_000), artifacts: z.array(relativePath).default([]) }).strict().parse(input);
        const fingerprint = this.workspaces.fingerprint(task.workspace!);
        const body = canonical({ ...args, summary: redact(args.summary, this.secrets), fingerprint });
        const old = this.store.get<{ body: string; worker: string }>('SELECT body,worker FROM checkpoints WHERE id=?', args.id);
        if (old && (old.body !== body || old.worker !== worker.id)) throw new Error('checkpoint ID collision');
        this.store.run('INSERT OR IGNORE INTO checkpoints VALUES (?,?,?,?,?)', args.id, task.id, worker.id, body, Date.now());
        return { id: args.id, fingerprint };
      }
      case 'block': {
        if (worker.readOnly) throw new Error('read-only responder cannot change implementation state');
        const args = z.object({ reason: z.string().min(1).max(5000), waitingFor: id.optional(), human: z.boolean().default(false) }).strict().parse(input);
        if (args.waitingFor) this.store.task(args.waitingFor);
        if (task.state !== 'running') throw new Error('only running work may declare a blocker');
        transition(this.store, task.id, args.human ? 'needs_human' : 'blocked', redact(args.reason, this.secrets));
        this.store.updateTask(task.id, { waitingFor: args.waitingFor ?? null });
        return { state: this.store.task(task.id).state };
      }
      case 'submit': {
        if (worker.readOnly) throw new Error('read-only worker cannot submit implementation');
        const submission = submissionSchema.parse(input);
        if (task.state === 'submitted' && task.submission === canonical(submission)) return { state: task.state };
        if (task.state !== 'running') throw new Error('only running owner can submit');
        this.workspaces.validate(this.store.spec(task), this.store.policy(task), task.workspace!, task.baseCommit, submission);
        this.store.transaction(() => {
          this.store.updateTask(task.id, { submission: canonical(submission) });
          this.store.evidence(task, 'submission', submission);
          transition(this.store, task.id, 'submitted', 'owner submitted immutable commit; independent verification pending');
        });
        return { state: 'submitted', commit: submission.commit };
      }
      default: throw new Error('unknown worker capability');
    }
  }
  answer(input: unknown): MailRow {
    const args = z.object({ question: id, body: z.string().min(1).max(20_000), decisionRecord: relativePath.optional() }).strict().parse(input);
    const question = this.store.get<MailRow>('SELECT * FROM messages WHERE id=?', args.question);
    if (!question || question.recipient !== 'operator') throw new Error('not an operator-addressed question');
    if (question.type === 'proposal' && !args.decisionRecord) throw new Error('proposal requires a committed authoritative decision record and new revision approval');
    if (args.decisionRecord) {
      const commit = this.workspaces.commit('HEAD');
      const record = git(this.workspaces.repo, ['show', `${commit}:${args.decisionRecord}`]);
      this.store.event('decision', 'operator accepted versioned decision; revised criteria still require import/approval', question.task, { path: args.decisionRecord, commit, hash: hash(record) });
    }
    return this.sendMail('operator', { id: `answer_${hash({ question: args.question, body: args.body }).slice(0, 24)}`, thread: question.thread, to: question.sender, task: question.task, type: args.decisionRecord ? 'decision' : 'answer', body: args.body, replyTo: question.id } satisfies MailInput, true);
  }
  async listen(): Promise<string> {
    this.server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST' || req.headers.origin) throw new Error('only authenticated local POST requests supported');
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const parts = (req.url ?? '').split('/').filter(Boolean);
        let body = ''; for await (const chunk of req) { body += String(chunk); if (body.length > 100_000) throw new Error('request too large'); }
        const input: unknown = JSON.parse(body || '{}');
        let output: unknown;
        if (parts[0] === 'worker') output = await this.workerAction(this.worker(token, String(req.headers['x-harness-session'] ?? '')), parts[1] ?? '', input);
        else {
          if (token.length !== this.operatorToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(this.operatorToken))) throw new Error('unauthorized operator');
          if (parts[0] !== 'operator' || !parts[1]) throw new Error('unknown API route');
          output = await this.onControl?.(parts[1], z.record(z.string(), z.unknown()).parse(input));
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output ?? { ok: true }));
      } catch (error) { res.writeHead(/unauthorized/.test(errorText(error)) ? 403 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: redact(errorText(error), this.secrets) })); }
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('invalid service address');
    this.url = `http://127.0.0.1:${address.port}`;
    privateWrite(join(this.workspaces.runtime, 'endpoint.json'), { url: this.url, pid: process.pid });
    return this.url;
  }
  async close(): Promise<void> { await new Promise<void>((resolve, reject) => { if (!this.server) return resolve(); this.server.close(error => error ? reject(error) : resolve()); this.server.closeAllConnections(); }); }
}
