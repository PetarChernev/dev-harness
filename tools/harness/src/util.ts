import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { relativePath } from './schema.js';

export const uid = (prefix = 'id'): string => `${prefix}_${randomBytes(12).toString('hex')}`;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function redact(text: string, secrets: string[] = []): string {
  let output = text.replace(/(Bearer|Basic)\s+[a-zA-Z0-9+/_=.:-]+/g, '$1 [REDACTED]').replace(/((?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]');
  for (const secret of secrets) if (secret.length > 3) output = output.split(secret).join('[REDACTED]');
  return output;
}
export function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${redact(result.error?.message ?? result.stderr.trim())}`);
  return result.stdout.trimEnd();
}
export function matches(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00\//g, '(?:.*/)?').replace(/\x00/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}
export function safePath(root: string, name: string, allowMissing = false): string {
  relativePath.parse(name);
  const base = realpathSync(root), target = resolve(base, name);
  if (!target.startsWith(base + sep)) throw new Error('path escapes root');
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) { if (allowMissing) continue; throw new Error(`missing artifact/path: ${name}`); }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink boundary: ${name}`);
    const real = realpathSync(cursor);
    if (relative(base, real).startsWith('..')) throw new Error('path escapes root');
  }
  return target;
}
export function privateWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export interface ProcessIdentity { pid: number; start: string | null }
export function identity(pid = process.pid): ProcessIdentity {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null }; } catch { return { pid, start: null }; }
}
export function processState(owner: ProcessIdentity): 'alive' | 'dead' | 'uncertain' {
  try { process.kill(owner.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'uncertain'; }
  const current = identity(owner.pid);
  if (owner.start !== null && current.start !== null) return current.start === owner.start ? 'alive' : 'dead';
  return 'uncertain';
}
export function runtimeLocation(repoInput: string, explicit?: string): { repo: string; runtime: string } {
  const requested = realpathSync(resolve(repoInput));
  const common = realpathSync(resolve(requested, git(requested, ['rev-parse', '--git-common-dir'])));
  const worktrees = git(requested, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const repo = realpathSync(worktrees.find(line => line.startsWith('worktree '))!.slice(9));
  const marker = join(common, 'harness-location.json');
  const saved: unknown = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
  const location = typeof saved === 'string' ? saved : join(common, 'harness');
  if (explicit && resolve(explicit) !== resolve(location) && saved !== null) throw new Error(`canonical runtime already established: ${location}`);
  const runtime = resolve(explicit ?? location);
  for (const line of worktrees.filter(l => l.startsWith('worktree '))) {
    const checkout = line.slice(9);
    if ((runtime === checkout || runtime.startsWith(checkout + sep)) && !runtime.startsWith(common + sep)) throw new Error('runtime must be outside worker/user checkout content');
  }
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(runtime);
  if (saved === null) writeFileSync(marker, JSON.stringify(resolved), { flag: 'wx', mode: 0o600 });
  if (saved !== null && realpathSync(location) !== resolved) throw new Error('runtime mismatch');
  return { repo, runtime: resolved };
}
