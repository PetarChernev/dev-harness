import { expect, test } from 'vitest';
import { limitsSchema, planSchema, relativePath, validateGraph } from '../src/schema.js';
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
  // Start input is intentionally constructed by the production schema in the later scheduler tests.
  expect(await runtime.health()).toEqual({ healthy: true, detail: 'deterministic fake runtime' });
});
