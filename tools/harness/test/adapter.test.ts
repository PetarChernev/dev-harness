import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeRuntime, verifyPermissions } from '../src/opencode.js';
import { privateWrite } from '../src/util.js';
import type { WorkerHandle } from '../src/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

test('official SDK uses verified async shapes, authentication and directory/session scoping; errors and permission requests stay explicit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-contract-'));
  let status: 'idle' | 'busy' = 'idle', permission = false;
  const received: { path: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('opencode:probe-password').toString('base64')}`);
    const url = new URL(req.url!, 'http://127.0.0.1'); expect(url.searchParams.get('directory')).toBe(directory);
    let body = ''; for await (const chunk of req) body += String(chunk);
    received.push({ path: url.pathname, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/permission') res.end(JSON.stringify(permission ? [{ id: 'perm_other', sessionID: 'other' }, { id: 'perm_owned', sessionID: 'ses_owned' }] : []));
    else if (url.pathname === '/session/status') res.end(JSON.stringify({ ses_owned: { type: status } }));
    else if (url.pathname === '/session/ses_owned/prompt_async') { status = 'busy'; res.statusCode = 204; res.end(); }
    else if (url.pathname === '/session/ses_owned/message') res.end(JSON.stringify([{ info: { id: 'msg_user', sessionID: 'ses_owned', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'work' }] }, { info: { id: 'msg_reply', sessionID: 'ses_owned', parentID: 'msg_user', role: 'assistant', time: { created: 2, completed: 3 }, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 1, write: 0 } }, cost: 0 }, parts: [{ type: 'text', text: 'result' }] }]));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: 'missing' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
  const secretFile = join(directory, 'secret.json'); privateWrite(secretFile, { password: 'probe-password', token: 'worker-only' });
  const handle: WorkerHandle = { id: 'owned', session: 'ses_owned', directory, metadata: { baseUrl: `http://127.0.0.1:${address.port}`, secretFile, pid: 999999, start: '1', model: { providerID: 'existing', modelID: 'configured' }, agent: 'harness_worker', steps: 4 } };
  const runtime = new OpenCodeRuntime(directory);
  expect(await runtime.dispatch(handle, 'msg_user', 'work')).toBe('accepted');
  expect(received.at(-1)!.body).toMatchObject({ messageID: 'msg_user', model: { providerID: 'existing', modelID: 'configured' }, parts: [{ type: 'text', text: 'work' }] });
  await expect(runtime.dispatch(handle, 'msg_competing', 'other')).rejects.toThrow('in-flight');
  permission = true; expect(await runtime.status(handle)).toEqual({ state: 'permission', permissionIds: ['perm_owned'] });
  permission = false; status = 'idle'; expect(await runtime.status(handle)).toEqual({ state: 'idle' });
  const history = await runtime.messages(handle); expect(history[1]).toMatchObject({ id: 'msg_reply', parent: 'msg_user', tokens: 17, cost: null, complete: true });
});

test('effective permission audit rejects inherited grants and only recognizes tested built-in suffix', () => {
  const desired = { '*': 'ask', task: 'deny' } as const;
  const intended = [{ permission: '*', pattern: '*', action: 'ask' }, { permission: 'task', pattern: '*', action: 'deny' }] as const;
  expect(() => verifyPermissions([...intended], desired)).not.toThrow();
  expect(() => verifyPermissions([...intended, { permission: 'bash', pattern: '*', action: 'allow' }], desired)).toThrow('effective');
  expect(() => verifyPermissions([...intended, { permission: 'external_directory', pattern: '/known/tool-output/*', action: 'allow' }], desired, '/known/tool-output/*')).not.toThrow();
  expect(() => verifyPermissions([...intended, { permission: 'external_directory', pattern: '/secrets/*', action: 'allow' }], desired, '/known/tool-output/*')).toThrow('effective');
});
