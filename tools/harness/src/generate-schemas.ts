import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { planSchema, projectSchema, taskSchema } from './schema.js';
import { packageRoot } from './profiles.js';
import { git, hash } from './util.js';
import { readFileSync } from 'node:fs';

const output = join(packageRoot, 'schemas'); mkdirSync(output, { recursive: true });
for (const [name, schema] of Object.entries({ project: projectSchema, task: taskSchema, plan: planSchema })) {
  writeFileSync(join(output, `${name}-v1.schema.json`), JSON.stringify({ ...z.toJSONSchema(schema), $id: `urn:local-first:harness:${name}:v1` }, null, 2) + '\n');
}
let sourceRevision: string | null = null, sourceDirty: boolean | null = null;
try { sourceRevision = git(packageRoot, ['rev-parse', 'HEAD']); sourceDirty = Boolean(git(packageRoot, ['status', '--porcelain', '--', '.'])); } catch { /* Installed packages need no Git ancestry of the package itself. */ }
writeFileSync(join(packageRoot, 'dist/build-info.json'), JSON.stringify({ sourceRevision, sourceDirty, node: process.version, dependencyLock: hash(readFileSync(join(packageRoot, 'npm-shrinkwrap.json'))) }, null, 2) + '\n');
