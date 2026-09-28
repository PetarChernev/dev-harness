import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command, Project } from './schema.js';
import { canonical, errorText, hash, identity, redact, safePath, uid } from './util.js';
import type { Store, TaskRow } from './store.js';

export class Capacity {
  private used = 0;
  private readonly waiting: { units: number; resolve: (release: () => void) => void }[] = [];
  constructor(readonly max: number) {}
  acquire(units = 1): Promise<() => void> {
    if (units > this.max) return Promise.reject(new Error(`resource request ${units} exceeds limit ${this.max}`));
    return new Promise(resolve => { this.waiting.push({ units, resolve }); this.pump(); });
  }
  private pump(): void {
    while (this.waiting[0] && this.used + this.waiting[0].units <= this.max) {
      const waiter = this.waiting.shift()!; this.used += waiter.units;
      let released = false;
      waiter.resolve(() => { if (!released) { released = true; this.used -= waiter.units; this.pump(); } });
    }
  }
}
export interface CommandResult { action: string; command: string; exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null; log: string; artifacts: { path: string; sha256: string; bytes: number }[]; started: number; ended: number; passed: boolean }
export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: homedir(), LANG: 'C.UTF-8', SYSTEMROOT: process.env.SYSTEMROOT, ...extra };
}
export class CommandRunner {
  readonly jobs: Capacity;
  readonly graphics: Capacity;
  private readonly running = new Map<string, () => void>();
  constructor(readonly store: Store, readonly runtime: string, readonly policy: Project) { this.jobs = new Capacity(policy.resources.buildJobs); this.graphics = new Capacity(policy.resources.graphical); }
  async run(task: TaskRow, name: string, command: Command, workspace: string): Promise<CommandResult> {
    const releaseGraphics = command.graphical ? await this.graphics.acquire() : () => {};
    let releaseJobs: () => void;
    try { releaseJobs = await this.jobs.acquire(command.buildJobs); } catch (error) { releaseGraphics(); throw error; }
    try { return await this.execute(task, name, command, workspace); } finally { releaseJobs(); releaseGraphics(); }
  }
  private async execute(task: TaskRow, name: string, command: Command, workspace: string): Promise<CommandResult> {
    const action = uid('command'), directory = join(this.runtime, 'artifacts', action);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = join(directory, 'tmp'); mkdirSync(tmp);
    const cwd = command.cwd === '.' ? workspace : safePath(workspace, command.cwd);
    const result: CommandResult = { action, command: name, exitCode: null, signal: null, timedOut: false, error: null, log: join(directory, 'output.log'), artifacts: [], started: Date.now(), ended: 0, passed: false };
    const env = minimalEnv({ ...command.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HARNESS_ARTIFACT_DIR: directory, CARGO_TARGET_DIR: join(directory, 'build'), CARGO_BUILD_JOBS: String(Math.max(command.buildJobs, 1)) });
    let executable = command.executable, args = command.args;
    if (this.policy.sandbox) { args = [...this.policy.sandbox.args, executable, ...args]; executable = this.policy.sandbox.executable; }
    this.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', action, task.id, 'command', 'intent', canonical({ name, command, cwd }), null, result.started);
    const log = createWriteStream(result.log, { mode: 0o600 });
    let bytes = 0;
    await new Promise<void>(resolve => {
      const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const terminate = (): void => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
      this.running.set(action, terminate);
      const timer = setTimeout(() => { result.timedOut = true; terminate(); }, command.timeoutMs);
      child.once('spawn', () => { this.store.run('UPDATE actions SET status=?,data=? WHERE id=?', 'running', canonical({ name, command, cwd, process: identity(child.pid!) }), action); });
      const output = (chunk: Buffer): void => { if (bytes < 1_000_000) { const redacted = redact(chunk.toString(), Object.entries(command.env).filter(([k]) => /key|token|password/i.test(k)).map(([, v]) => v)); log.write(redacted.slice(0, 1_000_000 - bytes)); bytes += Buffer.byteLength(redacted); } };
      child.stdout?.on('data', output); child.stderr?.on('data', output);
      child.once('error', error => { result.error = errorText(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); this.running.delete(action); result.exitCode = code; result.signal = signal; log.end(); resolve(); });
    });
    result.ended = Date.now();
    try {
      for (const artifact of command.artifacts) {
        const path = safePath(workspace, artifact), data = readFileSync(path);
        if (!statSync(path).isFile() || data.length > 20_000_000) throw new Error('artifact must be a file <=20MB');
        const saved = join(directory, `${result.artifacts.length}-${artifact.split('/').at(-1)}`); writeFileSync(saved, data, { mode: 0o600 });
        result.artifacts.push({ path: saved, sha256: hash(data), bytes: data.length });
      }
    } catch (error) { result.error = errorText(error); }
    result.passed = result.exitCode === 0 && !result.timedOut && !result.error;
    this.store.run('UPDATE actions SET status=?,result=? WHERE id=?', 'finished', canonical(result), action);
    this.store.evidence(task, 'command', result);
    this.store.event('command', result.passed ? 'approved command passed' : 'approved command failed', task.id, result);
    return result;
  }
  stop(): void { for (const terminate of this.running.values()) terminate(); }
}
