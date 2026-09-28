import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
export interface CommandResult { action: string; command: string; exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null; log: string; outputPreview: string; artifacts: { path: string; sha256: string; bytes: number }[]; started: number; ended: number; passed: boolean }
export function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: homedir(), LANG: 'C.UTF-8', SYSTEMROOT: process.env.SYSTEMROOT, ...extra };
}
export class CommandRunner {
  readonly jobs: Capacity;
  readonly graphics: Capacity;
  private readonly running = new Map<string, () => void>();
  private stopping = false;
  private readonly outstanding = new Set<Promise<CommandResult>>();
  private readonly cancelled = new Set<string>();
  constructor(readonly store: Store, readonly runtime: string, readonly policy: Project) { this.jobs = new Capacity(policy.resources.buildJobs); this.graphics = new Capacity(policy.resources.graphical); }
  run(task: TaskRow, name: string, command: Command, workspace: string, action = uid('command')): Promise<CommandResult> {
    const promise = this.runManaged(task, name, command, workspace, action); this.outstanding.add(promise);
    void promise.finally(() => this.outstanding.delete(promise)).catch(() => {}); return promise;
  }
  private async runManaged(task: TaskRow, name: string, command: Command, workspace: string, action: string): Promise<CommandResult> {
    if (hash(this.store.policy(task)) !== hash(this.policy)) throw new Error('command resource/launcher policy differs from approved snapshot');
    this.store.run('INSERT INTO actions VALUES (?,?,?,?,?,?,?)', action, task.id, 'command', 'queued', canonical({ name, command, cwd: workspace }), null, Date.now());
    let releaseGraphics = (): void => {}, releaseJobs = (): void => {};
    try {
      if (this.stopping) throw new Error('command runner stopping');
      if (command.graphical) releaseGraphics = await this.graphics.acquire();
      releaseJobs = await this.jobs.acquire(command.buildJobs);
      if (this.stopping || this.cancelled.has(action)) throw new Error('queued command cancelled during stop');
      return await this.execute(task, name, command, workspace, action);
    } catch (error) {
      this.store.run("UPDATE actions SET status='failed',result=? WHERE id=?", canonical({ error: errorText(error), passed: false }), action);
      throw error;
    } finally { releaseJobs(); releaseGraphics(); }
  }
  private async execute(task: TaskRow, name: string, command: Command, workspace: string, action: string): Promise<CommandResult> {
    const directory = join(this.runtime, 'artifacts', action);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = join(directory, 'tmp'); mkdirSync(tmp);
    const data = join(directory, 'data'); mkdirSync(data);
    const cwd = command.cwd === '.' ? workspace : safePath(workspace, command.cwd);
    const result: CommandResult = { action, command: name, exitCode: null, signal: null, timedOut: false, error: null, log: join(directory, 'output.log'), outputPreview: '', artifacts: [], started: Date.now(), ended: 0, passed: false };
    const inherited = Object.fromEntries(command.envFrom.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    const variables: Record<string, string> = { artifactDir: directory, buildDir: join(directory, 'build'), buildJobs: String(Math.max(command.buildJobs, 1)), tempDir: tmp, dataDir: data, workspace };
    const expand = (value: string): string => value.replace(/\{(artifactDir|buildDir|buildJobs|tempDir|dataDir|workspace)\}/g, (_, key: string) => variables[key]!);
    const configured = Object.fromEntries(Object.entries({ ...this.policy.executionEnv, ...command.env }).map(([key, value]) => [key, expand(value)]));
    const env = minimalEnv({ ...inherited, ...configured, TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_DATA_HOME: data, XDG_STATE_HOME: join(data, 'state'), HARNESS_ARTIFACT_DIR: directory, HARNESS_BUILD_DIR: variables.buildDir!, HARNESS_BUILD_JOBS: variables.buildJobs! });
    let executable = command.executable, args = command.args.map(expand);
    if (this.policy.sandbox) { args = [...this.policy.sandbox.args, executable, ...args]; executable = this.policy.sandbox.executable; }
    this.store.run("UPDATE actions SET status='intent',data=? WHERE id=?", canonical({ name, command, cwd }), action);
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>(resolve => {
      const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const terminate = (): void => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ } };
      this.running.set(action, terminate);
      const timer = setTimeout(() => { result.timedOut = true; terminate(); }, command.timeoutMs);
      child.once('spawn', () => { this.store.run('UPDATE actions SET status=?,data=? WHERE id=?', 'running', canonical({ name, command, cwd, process: identity(child.pid!) }), action); });
      const output = (chunk: Buffer): void => { if (bytes < 1_000_000) { const kept = chunk.subarray(0, 1_000_000 - bytes); chunks.push(kept); bytes += kept.length; } };
      child.stdout?.on('data', output); child.stderr?.on('data', output);
      child.once('error', error => { result.error = errorText(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); this.running.delete(action); result.exitCode = code; result.signal = signal; resolve(); });
    });
    // Redact after concatenating bounded output so credentials split across pipe chunks cannot leak.
    const output = redact(Buffer.concat(chunks).toString('utf8'), Object.entries({ ...inherited, ...configured }).filter(([key]) => /key|token|password|secret/i.test(key)).map(([, value]) => value));
    writeFileSync(result.log, output, { mode: 0o600 }); result.outputPreview = output.length > 4000 ? `${output.slice(0, 1500)}\n[truncated; use harness_evidence]\n${output.slice(-2500)}` : output;
    result.ended = Date.now();
    try {
      for (const artifact of command.artifacts) {
        const path = safePath(workspace, artifact), info = statSync(path);
        if (!info.isFile() || info.size > 20_000_000) throw new Error('artifact must be a file <=20MB');
        const data = readFileSync(path);
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
  stop(): void { this.stopping = true; for (const terminate of this.running.values()) terminate(); }
  cancelTask(task: string): void {
    for (const { id } of this.store.all<{ id: string }>("SELECT id FROM actions WHERE task=? AND kind='command' AND status IN ('queued','intent','running')", task)) { this.cancelled.add(id); this.running.get(id)?.(); }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.outstanding]); }
}
