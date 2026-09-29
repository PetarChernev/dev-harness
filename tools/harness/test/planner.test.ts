import { afterEach, expect, test } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { fixture, spec } from './helpers.js';
import { generatePlan, plannerPlanSchema } from '../src/llm-roles.js';
import { planSchema } from '../src/schema.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const f = await fixture(); cleanups.push(() => f.cleanup());
  f.policy.roles.planner = { instructions: 'Draft only.', readOnly: true };
  const brief = join(f.repo, 'brief.md'), output = join(f.repo, 'proposed.yaml');
  writeFileSync(brief, 'Record evidence for the existing neutral starter.');
  const proposal = { schemaVersion: 1, milestone: 'm', baseCommit: f.base, tasks: [spec()] };
  return { f, brief, output, proposal };
}

test('planner schema applies every project ceiling/default while preserving task refinements', async () => {
  const { f, proposal } = await setup();
  f.policy.defaults = { attempts: 2, prompts: 4, steps: 5, elapsedMs: 60_000, noProgress: 2, providerRetries: 0, sessionPrompts: 3, tokens: 500, costUsd: 0.25 };
  const schema = plannerPlanSchema(f.policy), caps = structuredClone(f.policy.defaults);
  const input = { ...proposal, tasks: [{ ...spec(), limits: {} }] };
  expect(schema.parse(input).tasks[0]!.limits).toEqual(caps);
  expect(z.toJSONSchema(schema)).toMatchObject({ properties: { tasks: { items: { properties: {
    limits: { properties: Object.fromEntries(Object.entries(caps).map(([key, maximum]) => [key, { maximum, default: maximum }])) },
  } } } } });
  for (const [key, maximum] of Object.entries(caps)) {
    expect(schema.safeParse({ ...proposal, tasks: [{ ...spec(), limits: { ...caps, [key]: maximum + 1 } }] }).success, key).toBe(false);
  }
  expect(schema.safeParse({ ...proposal, tasks: [{ ...spec(), kind: 'research', artifacts: [], limits: caps }] }).success).toBe(false);
  expect(f.policy.defaults).toEqual(caps);
  // Draft generation must not narrow the general import schema or raise the project policy.
  expect(planSchema.safeParse({ ...proposal, tasks: [spec('a', { limits: { ...spec().limits, steps: 30 } })] }).success).toBe(true);
});

test('planner receives the same bounded schema used to validate its result, including lower project defaults', async () => {
  const { f, brief, output, proposal } = await setup();
  f.policy.defaults.steps = 4; f.policy.defaults.elapsedMs = 30_000; f.policy.defaults.costUsd = 0.5;
  const schema = plannerPlanSchema(f.policy);
  f.runtimeAdapter.onDispatch = async (input, _id, prompt) => {
    expect(input.task.limits.steps).toBe(4); expect(input.task.limits.elapsedMs).toBe(30_000);
    expect(prompt).toContain(JSON.stringify(z.toJSONSchema(schema)));
    expect(prompt).toContain('iterations PER PROMPT');
    f.runtimeAdapter.finish(f.runtimeAdapter.sessions.get(`session_${input.id}`)!.handle, JSON.stringify({ ...proposal, tasks: [{ ...spec(), limits: {} }] }));
  };
  await generatePlan(f.store, f.service, f.workspaces, f.runtimeAdapter, f.policy, brief, output);
  const draft = planSchema.parse(parse(readFileSync(output, 'utf8')));
  expect(draft.tasks[0]!.limits).toEqual(f.policy.defaults);
  expect(f.runtimeAdapter.prompts).toHaveLength(1);
  expect(f.store.tasks()).toHaveLength(0); expect(f.store.all('SELECT * FROM approvals')).toHaveLength(0);
  expect([...f.runtimeAdapter.sessions.values()].every(session => session.stopped)).toBe(true);
});

test('30-step proposal is rejected at a 12-step ceiling with useful diagnostics and no policy/task mutation', async () => {
  const { f, brief, output, proposal } = await setup();
  f.store.importPlan({ ...proposal, tasks: [spec('existing')] });
  const before = f.store.tasks(), policy = structuredClone(f.policy);
  const excessive = { ...proposal, tasks: [spec('a', { limits: { ...spec().limits, steps: 30 } })] };
  f.runtimeAdapter.onDispatch = async input => { f.runtimeAdapter.finish(f.runtimeAdapter.sessions.get(`session_${input.id}`)!.handle, JSON.stringify(excessive)); };
  await expect(generatePlan(f.store, f.service, f.workspaces, f.runtimeAdapter, f.policy, brief, output)).rejects.toThrow('tasks.0.limits.steps: requested 30; project maximum for steps is 12');
  expect(existsSync(output)).toBe(false); expect(f.policy).toEqual(policy); expect(f.store.tasks()).toEqual(before);
  expect(f.store.all('SELECT * FROM approvals')).toHaveLength(0); expect(f.runtimeAdapter.prompts).toHaveLength(1);
  const saved = f.store.get<{ result: string }>("SELECT result FROM actions WHERE kind='readonly-role'")!;
  expect(JSON.parse(saved.result).output).toEqual(excessive);
  expect(f.store.all("SELECT * FROM events WHERE type='plan-rejected'")).toHaveLength(1);
  expect([...f.runtimeAdapter.sessions.values()].every(session => session.stopped)).toBe(true);
});

test('existing plan output is preserved and rejected before starting a model session', async () => {
  const { f, brief, output } = await setup(); writeFileSync(output, 'existing operator draft\n');
  await expect(generatePlan(f.store, f.service, f.workspaces, f.runtimeAdapter, f.policy, brief, output)).rejects.toThrow('plan output already exists');
  expect(readFileSync(output, 'utf8')).toBe('existing operator draft\n');
  expect(f.runtimeAdapter.sessions.size).toBe(0); expect(f.store.all('SELECT * FROM actions')).toHaveLength(0);
});
