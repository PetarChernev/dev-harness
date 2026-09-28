import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const output = resolve(process.argv[2] ?? '../../.local/probe');
await mkdir(output, { recursive: true });
const directory = await realpath(await mkdtemp(join(output, 'checkout-')));
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(r => listener.close(r));
const password = randomBytes(24).toString('hex');
const baseUrl = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: directory, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled', permission: { '*': 'ask', task: 'deny' } }) }, stdio: 'ignore',
});
const client = createOpencodeClient({ baseUrl, directory, headers });
try {
  let healthy;
  for (let i = 0; i < 100; i++) {
    try { healthy = (await client.global.health({ signal: AbortSignal.timeout(500) })).data; if (healthy?.healthy) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!healthy?.healthy) throw new Error('owned server did not become healthy');
  const authDenied = (await fetch(`${baseUrl}/path`)).status;
  const specText = await (await fetch(`${baseUrl}/doc`, { headers })).text();
  const spec = JSON.parse(specText);
  await writeFile(join(output, 'openapi.json'), specText);
  const path = (await client.path.get({ directory }, { throwOnError: true })).data;
  if (await realpath(path.directory) !== directory) throw new Error('directory mismatch');
  const config = (await client.config.get({ directory }, { throwOnError: true })).data;
  const providers = (await client.provider.list({ directory }, { throwOnError: true })).data;
  const agents = (await client.app.agents({ directory }, { throwOnError: true })).data;
  const session = (await client.session.create({ directory, title: 'Harness compatibility probe' }, { throwOnError: true })).data;
  const messageID = 'msg_' + randomBytes(16).toString('hex');
  const asyncResult = await client.session.promptAsync({ directory, sessionID: session.id, messageID, noReply: true, parts: [{ type: 'text', text: 'Compatibility probe only. No reply or tools requested.' }] });
  let history = [];
  for (let i = 0; i < 20; i++) {
    history = (await client.session.messages({ directory, sessionID: session.id }, { throwOnError: true })).data;
    if (history.some(m => m.info.id === messageID)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const permissions = (await client.permission.list({ directory }, { throwOnError: true })).data;
  const bad = await client.session.get({ directory, sessionID: 'ses_nonexistent' });
  const status = (await client.session.status({ directory }, { throwOnError: true })).data;
  const report = {
    version: healthy.version, sdk: '1.18.33', authDenied, directoryMatches: true,
    openapiSha256: createHash('sha256').update(specText).digest('hex'),
    operations: Object.values(spec.paths).flatMap(p => Object.values(p).map(op => op.operationId)).filter(Boolean),
    configuredModel: config.model ?? null, connectedProviders: providers.connected,
    agentSteps: agents.map(a => ({ name: a.name, steps: a.steps ?? null })),
    configuredPlugins: config.plugin?.length ?? 0, mcpNames: Object.keys(config.mcp ?? {}),
    asyncStatus: asyncResult.response.status, messageIdentityPreserved: history.some(m => m.info.id === messageID),
    sessionDirectoryMatches: session.directory === directory, permissionsIsArray: Array.isArray(permissions),
    missingSessionStatus: bad.response.status, missingSessionHasError: Boolean(bad.error), sessionStatus: status[session.id]?.type ?? 'idle',
    modelCalls: 0,
  };
  await client.session.delete({ directory, sessionID: session.id }, { throwOnError: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 3000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
