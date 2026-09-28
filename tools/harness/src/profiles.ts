import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { projectSchema } from './schema.js';
import type { Project } from './schema.js';
import { git } from './util.js';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadProject(repo: string): Project { return projectSchema.parse(parse(readFileSync(join(repo, '.harness/project.yaml'), 'utf8'))); }
export function initProject(repoInput: string, profile: 'generic-command' | 'rust-bevy'): string[] {
  const repo = resolve(repoInput); mkdirSync(repo, { recursive: true });
  if (!existsSync(join(repo, '.git'))) git(repo, ['init', '-b', 'main']);
  const files = new Map<string, string>();
  files.set('.harness/project.yaml', readFileSync(join(packageRoot, 'templates', profile, 'project.yaml'), 'utf8'));
  const template = join(packageRoot, 'templates', profile, 'files');
  const visit = (directory: string, prefix = ''): void => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${file.name}` : file.name;
      if (file.isDirectory()) visit(join(directory, file.name), path);
      else files.set(path.endsWith('.template') ? path.slice(0, -9) : path, readFileSync(join(directory, file.name), 'utf8'));
    }
  };
  if (existsSync(template)) visit(template);
  for (const path of files.keys()) if (existsSync(join(repo, path))) throw new Error(`refusing to overwrite existing file ${path}`);
  for (const [path, body] of files) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), body, { flag: 'wx' }); }
  return [...files.keys()];
}
export function writeProject(path: string, policy: Project): void { writeFileSync(path, stringify(projectSchema.parse(policy))); }
