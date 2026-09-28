import { expect, test } from 'vitest';
import { limitsSchema, planSchema, projectSchema, taskSchema, relativePath, validateGraph } from '../src/schema.js';
import { FakeRuntime } from '../src/runtime.js';

test('strict boundaries reject traversal, unknown fields and cyclic task graphs', () => {
  expect(relativePath.safeParse('../policy').success).toBe(false);
  expect(relativePath.safeParse('C:\\escape').success).toBe(false);
  expect(limitsSchema.safeParse({ unlimited: true }).success).toBe(false);
  const task = { id: 'a', revision: 1, milestone: 'm', objective: 'check', role: 'implementer', editablePaths: ['src/**'], acceptance: ['check passes'], verification: ['test'], limits: {} };
  const plan = planSchema.parse({ schemaVersion: 1, milestone: 'm', baseCommit: 'a'.repeat(40), tasks: [{ ...task, dependencies: [{ id: 'a', revision: 1 }] }] });
  expect(() => validateGraph(plan)).toThrow('cycle');
});

test('fake runtime has explicit turn boundaries and rejects competing prompts', async () => {
  const runtime = new FakeRuntime();
  const task = taskSchema.parse({ id: 'a', revision: 1, milestone: 'm', objective: 'test', role: 'implementer', editablePaths: [], acceptance: ['tested'], verification: ['test'], limits: {} });
  const policy = projectSchema.parse({ schemaVersion: 1, profile: 'generic-command', name: 'test', roles: { implementer: { instructions: 'test' } }, commands: { test: { executable: 'node' } } });
  const handle = await runtime.start({ id: 'worker', directory: '/disposable', task, policy, controlUrl: 'http://127.0.0.1:1', token: 'test' });
  await runtime.dispatch(handle, 'first', 'concrete work'); await expect(runtime.dispatch(handle, 'competing', 'not allowed')).rejects.toThrow('concurrent prompt');
  runtime.finish(handle); expect((await runtime.messages(handle)).at(-1)?.parent).toBe('first'); await runtime.dispatch(handle, 'next', 'next concrete unit'); expect((await runtime.status(handle)).state).toBe('busy');
});
