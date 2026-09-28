import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha } from './schema.js';
import type { Project, Submission, TaskSpec } from './schema.js';
import { git, hash, matches, safePath, uid } from './util.js';

export class Workspaces {
  constructor(readonly repo: string, readonly runtime: string) { mkdirSync(join(runtime, 'worktrees'), { recursive: true }); }
  commit(ref: string): string { return sha.parse(git(this.repo, ['rev-parse', '--verify', `${ref}^{commit}`])); }
  create(task: string, base: string, attempt: number): string {
    sha.parse(base);
    const path = join(this.runtime, 'worktrees', `${task}-${attempt}`);
    if (existsSync(path)) {
      if (git(path, ['rev-parse', '--show-toplevel']) !== path) throw new Error('workspace collision');
      return path;
    }
    git(this.repo, ['worktree', 'add', '-b', `harness/task-${task}-${attempt}-${uid('b')}`, path, base]);
    return path;
  }
  candidate(base: string, label = 'verify'): string {
    const path = join(this.runtime, 'worktrees', uid(label));
    git(this.repo, ['worktree', 'add', '--detach', path, sha.parse(base)]);
    return path;
  }
  changed(base: string, commit: string): string[] {
    // --no-renames makes both old/deleted and new paths visible for scope checks.
    return git(this.repo, ['diff', '--no-renames', '--name-only', '-z', sha.parse(base), sha.parse(commit), '--']).split('\0').filter(Boolean);
  }
  fingerprint(workspace: string): string {
    const untracked = git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    return hash({ head: git(workspace, ['rev-parse', 'HEAD']), diff: git(workspace, ['diff', 'HEAD', '--binary']), untracked: untracked.map(p => {
      try { const path = safePath(workspace, p); return [p, statSync(path).size <= 10_000_000 ? hash(readFileSync(path)) : statSync(path).mtimeMs]; } catch { return [p, 'unsafe']; }
    }) });
  }
  validate(spec: TaskSpec, policy: Project, workspace: string, base: string, submission: Submission): string[] {
    if (spec.revision !== submission.revision) throw new Error('obsolete task revision');
    if (git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('dirty submission workspace');
    const commit = this.commit(submission.commit);
    if (git(workspace, ['rev-parse', 'HEAD']) !== commit) throw new Error('submission must identify checkout HEAD');
    git(this.repo, ['merge-base', '--is-ancestor', sha.parse(base), commit]);
    const paths = this.changed(base, commit);
    if (spec.kind !== 'research' && paths.length === 0) throw new Error('code task requires an immutable nonempty change set');
    if (hash([...paths].sort()) !== hash([...new Set(submission.changes)].sort())) throw new Error('declared changes do not match actual paths');
    for (const path of paths) {
      if (!spec.editablePaths.some(p => matches(path, p))) throw new Error(`unexpected changed path ${path}`);
      if (policy.protectedPaths.some(p => matches(path, p)) && spec.kind !== 'maintenance') throw new Error(`protected policy/path ${path}`);
      if (policy.dependencyPaths.some(p => matches(path, p)) && !spec.allowDependencies) throw new Error(`dependency change not approved: ${path}`);
      for (const [key, patterns] of Object.entries(policy.sharedLocks)) if (patterns.some(p => matches(path, p)) && !spec.locks.includes(key)) throw new Error(`unapproved shared contract ${key}: ${path}`);
      safePath(workspace, path, true);
    }
    // Reject symlink/submodule entries anywhere in the candidate: commands could follow an unchanged escaping link.
    for (const entry of git(this.repo, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean)) {
      if (/^(120000|160000) /.test(entry)) throw new Error(`symlink/submodule candidate boundary: ${entry.split('\t')[1]}`);
    }
    for (const artifact of spec.artifacts) { const path = safePath(workspace, artifact); if (!statSync(path).isFile()) throw new Error(`artifact is not a file ${artifact}`); }
    if (spec.decisionRecord) {
      const text = git(this.repo, ['show', `${base}:${spec.decisionRecord}`]);
      if (!text.trim()) throw new Error('empty authoritative decision record');
    }
    return paths;
  }
  integrationHead(policy: Project, base: string): string {
    const ref = `refs/heads/${policy.integration.branch}`;
    try { return this.commit(ref); } catch { git(this.repo, ['update-ref', ref, sha.parse(base), '0'.repeat(40)]); return base; }
  }
  advance(policy: Project, previous: string, candidate: string): void {
    const ref = `refs/heads/${policy.integration.branch}`;
    if (git(this.repo, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`branch ${ref}`)) throw new Error('integration branch is checked out; refusing to move it');
    git(this.repo, ['update-ref', ref, sha.parse(candidate), sha.parse(previous)]);
  }
  promote(policy: Project, target: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(target)) throw new Error('invalid promotion branch');
    if (git(this.repo, ['status', '--porcelain'])) throw new Error('user checkout must be clean for promotion');
    if (git(this.repo, ['branch', '--show-current']) !== target) throw new Error('checkout the explicit promotion target first');
    git(this.repo, ['merge', '--ff-only', policy.integration.branch]);
  }
}
