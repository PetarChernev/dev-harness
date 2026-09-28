import type { Project, TaskSpec } from './schema.js';

export interface WorkerHandle { id: string; session: string; directory: string; metadata: Record<string, unknown> }
export interface StartWorker { id: string; directory: string; task: TaskSpec; policy: Project; controlUrl: string; token: string; readOnly?: boolean }
export interface RuntimeMessage { id: string; parent?: string; role: 'user' | 'assistant'; text: string; complete: boolean; error?: string; tokens: number | null; cost: number | null }
export interface RuntimeStatus { state: 'idle' | 'busy' | 'permission' | 'unavailable' | 'missing'; permissionIds?: string[]; retryAttempt?: number; nextRetryAt?: number }
export interface WorkerRuntime {
  start(input: StartWorker): Promise<WorkerHandle>;
  resume(handle: WorkerHandle): Promise<'owned' | 'stopped' | 'uncertain'>;
  dispatch(handle: WorkerHandle, requestId: string, prompt: string): Promise<'accepted' | 'rejected' | 'uncertain'>;
  status(handle: WorkerHandle): Promise<RuntimeStatus>;
  messages(handle: WorkerHandle): Promise<RuntimeMessage[]>;
  observe(handle: WorkerHandle, notify: () => void, signal: AbortSignal): Promise<void>;
  cancel(handle: WorkerHandle): Promise<'stopped' | 'uncertain'>;
  health(): Promise<{ healthy: boolean; detail: string }>;
  reconcileStart?(id: string): Promise<{ state: 'owned' | 'stopped' | 'uncertain'; handle?: WorkerHandle }>;
}
export class WorkerStartError extends Error {
  constructor(message: string, readonly stopped: boolean) { super(message); }
}

/** Deterministic adapter; all state/mail/Git/verification is still production code. */
export class FakeRuntime implements WorkerRuntime {
  readonly sessions = new Map<string, { handle: WorkerHandle; input: StartWorker; status: RuntimeStatus; messages: RuntimeMessage[]; stopped: boolean }>();
  readonly prompts: { worker: string; id: string; text: string }[] = [];
  onDispatch?: (input: StartWorker, id: string, text: string) => Promise<void>;
  outcome: 'accepted' | 'rejected' | 'uncertain' = 'accepted';
  recordUncertain = true;
  healthy = true;
  async start(input: StartWorker): Promise<WorkerHandle> {
    const handle = { id: input.id, session: `session_${input.id}`, directory: input.directory, metadata: { fake: true } };
    this.sessions.set(handle.session, { handle, input, status: { state: 'idle' }, messages: [], stopped: false });
    return handle;
  }
  async resume(h: WorkerHandle): Promise<'owned' | 'stopped' | 'uncertain'> { const s = this.sessions.get(h.session); return s ? (s.stopped ? 'stopped' : 'owned') : 'uncertain'; }
  async dispatch(h: WorkerHandle, requestId: string, prompt: string): Promise<'accepted' | 'rejected' | 'uncertain'> {
    const s = this.sessions.get(h.session)!;
    if (s.status.state === 'busy') throw new Error('concurrent prompt');
    this.prompts.push({ worker: h.id, id: requestId, text: prompt });
    if (this.outcome === 'rejected') return 'rejected';
    if (this.outcome === 'accepted' || this.recordUncertain) {
      s.messages.push({ id: requestId, role: 'user', text: prompt, complete: true, tokens: null, cost: null });
      s.status = { state: 'busy' };
      await this.onDispatch?.(s.input, requestId, prompt);
    }
    return this.outcome;
  }
  finish(h: WorkerHandle, text = 'Turn ended', error?: string): void {
    const s = this.sessions.get(h.session)!;
    s.messages.push({ id: `reply_${s.messages.length}`, parent: s.messages.at(-1)?.id, role: 'assistant', text, complete: true, error, tokens: 10, cost: null });
    s.status = { state: 'idle' };
  }
  async status(h: WorkerHandle): Promise<RuntimeStatus> { return this.sessions.get(h.session)?.status ?? { state: 'missing' }; }
  async messages(h: WorkerHandle): Promise<RuntimeMessage[]> { return this.sessions.get(h.session)?.messages ?? []; }
  async observe(_h: WorkerHandle, _notify: () => void, _signal: AbortSignal): Promise<void> { /* Poll reconciliation does not require events. */ }
  async cancel(h: WorkerHandle): Promise<'stopped'> { const s = this.sessions.get(h.session); if (s) { s.stopped = true; s.status = { state: 'idle' }; } return 'stopped'; }
  async health(): Promise<{ healthy: boolean; detail: string }> { return { healthy: this.healthy, detail: 'deterministic fake runtime' }; }
}
