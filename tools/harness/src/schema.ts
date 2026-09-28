import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const relativePath = z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && !p.split('/').some(s => s === '..' || s === '.' || s === '') && !/[\x00-\x1f]/.test(p), 'expected a normalized repository-relative path');
export const globPath = relativePath;
export const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
export const limitsSchema = z.object({
  attempts: z.number().int().min(1).max(10).default(3),
  prompts: z.number().int().min(1).max(1000).default(12),
  steps: z.number().int().min(1).max(100).default(12),
  elapsedMs: z.number().int().min(100).max(86_400_000).default(1_800_000),
  noProgress: z.number().int().min(1).max(20).default(3),
  providerRetries: z.number().int().min(0).max(10).default(2),
  sessionPrompts: z.number().int().min(1).max(100).default(8),
  tokens: z.number().int().positive().default(200_000),
  costUsd: z.number().positive().default(5),
}).strict();
export const commandSchema = z.object({
  executable: z.string().min(1), args: z.array(z.string()).default([]),
  cwd: z.union([z.literal('.'), relativePath]).default('.'),
  env: z.record(z.string(), z.string()).default({}),
  envFrom: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  artifacts: z.array(relativePath).default([]),
  graphical: z.boolean().default(false), buildJobs: z.number().int().min(0).max(128).default(1),
}).strict();
export const roleSchema = z.object({
  instructions: z.string().min(1),
  model: z.string().regex(/^[^/\s]+\/.+$/).optional(),
  readOnly: z.boolean().default(false),
}).strict();
export const projectSchema = z.object({
  schemaVersion: z.literal(1), profile: z.enum(['generic-command', 'rust-bevy']),
  name: id,
  roles: z.record(id, roleSchema), commands: z.record(id, commandSchema),
  resources: z.object({ implementations: z.number().int().min(1).max(32).default(3),
    verification: z.number().int().min(1).max(8).default(1), graphical: z.number().int().min(0).max(8).default(1),
    buildJobs: z.number().int().min(1).max(128).default(2),
  }).strict().default({ implementations: 3, verification: 1, graphical: 1, buildJobs: 2 }),
  defaults: limitsSchema.default(() => limitsSchema.parse({})),
  integration: z.object({ branch: z.string().regex(/^harness\/[a-zA-Z0-9_-]+$/).default('harness/integration'),
    checks: z.array(id).default([]), reviewRole: id.optional(),
  }).strict().default({ branch: 'harness/integration', checks: [] }),
  protectedPaths: z.array(globPath).default(['tools/harness/**', '.harness/**', '.opencode/**', 'opencode.json', '**/tests/**']),
  dependencyPaths: z.array(globPath).default(['**/package.json', '**/package-lock.json', '**/Cargo.toml', '**/Cargo.lock', 'package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock']),
  sharedLocks: z.record(id, z.array(globPath)).default({}),
  leaseMs: z.number().int().min(100).default(30_000), pollMs: z.number().int().min(10).default(1000),
  trustedLocal: z.literal(true).default(true),
  sandbox: z.object({ executable: z.string().min(1), args: z.array(z.string()) }).strict().optional(),
  providerEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  executionEnv: z.record(z.string(), z.string()).default({}),
  approvedPlugins: z.array(z.string()).default([]),
}).strict().superRefine((p, ctx) => {
  for (const name of p.integration.checks) if (!p.commands[name]) ctx.addIssue({ code: 'custom', message: `unknown integration command ${name}` });
  if (p.integration.reviewRole && (!p.roles[p.integration.reviewRole]?.readOnly)) ctx.addIssue({ code: 'custom', message: 'review role must exist and be read-only' });
});
export const taskSchema = z.object({
  id, revision: z.number().int().positive(), milestone: id,
  kind: z.enum(['code', 'research', 'maintenance']).default('code'),
  objective: z.string().min(1), dependencies: z.array(z.object({ id, revision: z.number().int().positive() }).strict()).default([]),
  role: id, editablePaths: z.array(globPath), locks: z.array(id).default([]),
  acceptance: z.array(z.string().min(1)).min(1), verification: z.array(id).min(1),
  artifacts: z.array(relativePath).default([]), limits: limitsSchema,
  decisionRecord: relativePath.optional(), allowDependencies: z.boolean().default(false),
}).strict().superRefine((t, ctx) => {
  if (t.kind === 'research' && t.artifacts.length === 0) ctx.addIssue({ code: 'custom', message: 'research requires a report/experiment artifact' });
  if ((t.kind === 'maintenance' || t.allowDependencies) && !t.decisionRecord) ctx.addIssue({ code: 'custom', message: 'maintenance/dependency changes require a versioned decision record' });
});
export const planSchema = z.object({ schemaVersion: z.literal(1), milestone: id, baseCommit: sha, tasks: z.array(taskSchema).min(1) }).strict();
export type Project = z.infer<typeof projectSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Command = z.infer<typeof commandSchema>;
export const reservedPaths = ['tools/harness/**', '.harness/**', '.opencode/**', 'opencode.json', 'opencode.jsonc'] as const;
export const states = ['draft', 'ready', 'running', 'submitted', 'verifying', 'integration', 'done', 'blocked', 'needs_human', 'failed', 'cancelled'] as const;
export type State = typeof states[number];
export const submissionSchema = z.object({ revision: z.number().int().positive(), commit: sha,
  changes: z.array(relativePath), evidence: z.array(z.string().min(1)).min(1), limitations: z.array(z.string()),
}).strict();
export type Submission = z.infer<typeof submissionSchema>;
export const mailSchema = z.object({ id, thread: id, to: id, task: id,
  type: z.enum(['question', 'answer', 'proposal', 'decision', 'blocker', 'evidence']),
  body: z.string().min(1).max(20_000), replyTo: id.optional(),
}).strict();
export type MailInput = z.infer<typeof mailSchema>;

export function validateGraph(plan: Plan, existing: TaskSpec[] = []): void {
  const graph = new Map(existing.map(t => [`${t.id}@${t.revision}`, t]));
  const names = new Set<string>();
  for (const task of plan.tasks) {
    if (names.has(task.id)) throw new Error(`duplicate task ${task.id}`);
    names.add(task.id);
    if (task.milestone !== plan.milestone) throw new Error('task milestone mismatch');
    graph.set(`${task.id}@${task.revision}`, task);
  }
  const visited = new Set<string>(), active = new Set<string>();
  function visit(key: string): void {
    if (active.has(key)) throw new Error(`dependency cycle at ${key}`);
    if (visited.has(key)) return;
    const task = graph.get(key);
    if (!task) throw new Error(`missing dependency ${key}`);
    active.add(key);
    for (const dep of task.dependencies) visit(`${dep.id}@${dep.revision}`);
    active.delete(key); visited.add(key);
  }
  for (const key of graph.keys()) visit(key);
}
