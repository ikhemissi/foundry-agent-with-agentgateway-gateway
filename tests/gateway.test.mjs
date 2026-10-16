import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const image = 'cr.agentgateway.dev/agentgateway:v1.6.0@sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c';
const runtime = process.env.CONTAINER_RUNTIME || 'podman';
const apiKey = 'local-compatibility-key-not-a-real-credential';
const identityHeader = 'local-identity-header-not-a-real-credential';
const token = 'local-managed-identity-token';
const sensitiveMessage = 'PRIVATE-COMPATIBILITY-MESSAGE-DO-NOT-CAPTURE';
const tenantId = '22222222-2222-2222-2222-222222222222';
const audience = '33333333-3333-3333-3333-333333333333';
const allowedPrincipal = '44444444-4444-4444-4444-444444444444';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('pinned gateway: Azure identity, authentication, inference, streaming and telemetry', { timeout: 90000 }, async (t) => {
  const upstreamRequests = [];
  const identityRequests = [];
  const traces = [];
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const jwt = (overrides = {}, signingKey = privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience, tid: tenantId, oid: allowedPrincipal, azp: 'test-agent',
      iat: now, nbf: now - 10, exp: now + 3600, idtyp: 'user', scp: 'gateway.invoke',
      ...overrides,
    })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
  };
  let releaseStream;
  const streamMayFinish = new Promise((resolve) => { releaseStream = resolve; });
  t.after(() => releaseStream());
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === '/identity') {
      identityRequests.push({ url, headers: request.headers });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        access_token: token,
        expires_on: String(Math.floor(Date.now() / 1000) + 3600),
        token_type: 'Bearer',
        resource: 'https://cognitiveservices.azure.com',
      }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (url.pathname === '/v1/traces') {
      traces.push(body);
      response.setHeader('content-type', 'application/x-protobuf');
      response.end();
      return;
    }
    if (!url.pathname.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const data = JSON.parse(body.toString());
    upstreamRequests.push({ url, headers: request.headers, data });
    if (data.messages.some((message) => message.content === 'upstream-error')) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Mock quota exhausted', type: 'rate_limit_error' } }));
    } else if (data.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finishReason] of [[{ role: 'assistant', content: 'Hello' }, null], [{ content: ' tutor' }, null], [{}, 'stop']]) {
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 1,
          model: 'gpt-5.4-nano', choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
        if (delta.role) await streamMayFinish;
      }
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        id: 'chatcmpl-local', object: 'chat.completion', created: 1,
        model: 'gpt-5.4-nano',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello tutor' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    }
  });
  const mockPort = await listen(mock);
  t.after(() => new Promise((resolve) => {
    mock.closeAllConnections();
    mock.close(resolve);
  }));
  const ports = {};
  for (const name of ['gateway', 'admin', 'stats', 'readiness']) ports[name] = await unusedPort();
  const directory = await mkdtemp(join(tmpdir(), 'agentgateway-compatibility-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let config = await readFile(new URL('../agentgateway/config.yaml', import.meta.url), 'utf8');
  const entra = (await readFile(new URL('../agentgateway/entra.yaml', import.meta.url), 'utf8'))
    .replaceAll('https://login.microsoftonline.com/$AZURE_TENANT_ID/discovery/v2.0/keys', `http://127.0.0.1:${mockPort}/jwks`)
    .replace('name: entra-source-model', `name: entra-source-model\n          hostOverride: 127.0.0.1:${mockPort}`)
    .replace('name: delegated-source-model', `name: delegated-source-model\n          hostOverride: 127.0.0.1:${mockPort}`);
  config += `\n${entra}`;
  for (const [original, replacement] of [
    ['127.0.0.1:15000', `127.0.0.1:${ports.admin}`],
    ['127.0.0.1:15020', `127.0.0.1:${ports.stats}`],
    ['0.0.0.0:15021', `127.0.0.1:${ports.readiness}`],
    ['http://127.0.0.1:4318', `http://127.0.0.1:${mockPort}`],
    ['port: 4000', `port: ${ports.gateway}`],
    ['bindAddress: 0.0.0.0', 'bindAddress: 127.0.0.1'],
    ['azureResourceType: openAI', `azureResourceType: openAI\n        baseUrl: http://127.0.0.1:${mockPort}`],
  ]) {
    assert.ok(config.includes(original), `Expected configuration setting: ${original}`);
    config = config.replace(original, replacement);
  }
  await writeFile(join(directory, 'config.yaml'), config);
  const name = `agentgateway-compatibility-${process.pid}`;
  const child = spawn(runtime, [
    'run', '--rm', '--network', 'host', '--name', name,
    '-v', `${directory}/config.yaml:/config.yaml:ro`,
    '-e', `AGENTGATEWAY_API_KEY=${apiKey}`,
    '-e', `AZURE_TENANT_ID=${tenantId}`,
    '-e', `AGENTGATEWAY_ENTRA_CLIENT_ID=${audience}`,
    '-e', `AGENTGATEWAY_ALLOWED_PRINCIPAL_IDS=${JSON.stringify([allowedPrincipal])}`,
    '-e', 'AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID=test-agent',
    '-e', 'SOURCE_AZURE_OPENAI_RESOURCE_NAME=local-source',
    '-e', 'AZURE_CLIENT_ID=11111111-1111-1111-1111-111111111111',
    '-e', `IDENTITY_ENDPOINT=http://127.0.0.1:${mockPort}/identity`,
    '-e', `IDENTITY_HEADER=${identityHeader}`,
    image, '-f', '/config.yaml',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let spawnError;
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
  });
  t.after(async () => {
    if (child.exitCode === null && !spawnError) {
      execFileSync(runtime, ['stop', '--time', '2', name], { stdio: 'pipe' });
      await exited;
    }
  });
  const base = `http://127.0.0.1:${ports.gateway}`;
  const ready = `http://127.0.0.1:${ports.readiness}/healthz/ready`;
  let started = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.ifError(spawnError);
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(ready, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) {
        started = true;
        break;
      }
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
    }
    await delay(100);
  }
  assert.ok(started, `Gateway did not become ready:\n${output}`);
  const completion = (authorization, overrides = {}, path = '/v1/chat/completions') => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
      traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
    },
    body: JSON.stringify({
      model: 'gpt-5.4-nano', messages: [{ role: 'user', content: sensitiveMessage }], ...overrides,
    }),
    signal: AbortSignal.timeout(10000),
  });

  await t.test('missing and invalid keys never reach the model', async () => {
    for (const key of [undefined, 'Bearer wrong-key']) {
      const response = await completion(key);
      assert.equal(response.status, 401);
      await response.text();
    }
    assert.equal(upstreamRequests.length, 0);
  });
  await t.test('valid bearer key uses the Container Apps identity endpoint', async () => {
    const response = await completion(`Bearer ${apiKey}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).choices[0].message.content, 'Hello tutor');
    assert.equal(identityRequests.length, 1);
    assert.equal(identityRequests[0].headers['x-identity-header'], identityHeader);
    assert.equal(identityRequests[0].url.searchParams.get('client_id'), '11111111-1111-1111-1111-111111111111');
    assert.equal(identityRequests[0].url.searchParams.get('resource'), 'https://cognitiveservices.azure.com');
    assert.equal(upstreamRequests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(upstreamRequests[0].url.pathname, '/openai/v1/chat/completions');
    assert.equal(upstreamRequests[0].data.model, 'gpt-5.4-nano');
  });
  await t.test('streaming returns OpenAI SSE chunks and DONE', async () => {
    const response = await completion(`Bearer ${apiKey}`, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, 'The first chunk must arrive before the upstream finishes');
    releaseStream();
    const buffers = [Buffer.from(first.value)];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffers.push(Buffer.from(next.value));
    }
    const events = Buffer.concat(buffers).toString().split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(events.at(-1), 'data: [DONE]');
    const chunks = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || '').join(''), 'Hello tutor');
    assert.equal(identityRequests.length, 1, 'The unexpired identity token should be cached');
  });
  await t.test('unknown models are rejected without calling the upstream', async () => {
    const count = upstreamRequests.length;
    const response = await completion(`Bearer ${apiKey}`, { model: 'unknown-model' });
    assert.equal(response.status, 404, await response.text());
    assert.equal(upstreamRequests.length, count);
  });
  await t.test('upstream failures are not converted into successes', async () => {
    const response = await completion(`Bearer ${apiKey}`, { messages: [{ role: 'user', content: 'upstream-error' }] });
    assert.equal(response.status, 429, await response.text());
  });
  await t.test('management endpoints are absent from inference ingress', async () => {
    const count = upstreamRequests.length;
    for (const path of ['/config_dump', '/ui/', '/metrics', '/healthz/ready']) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, 'invalid_request_body', path);
    }
    assert.equal(upstreamRequests.length, count);
    const response = await fetch(`http://127.0.0.1:${ports.stats}/metrics`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /gen_ai/);
  });
  await t.test('OTLP HTTP exports correlated traces without message content or credentials', async () => {
    for (let attempt = 0; attempt < 100 && traces.length === 0; attempt++) await delay(100);
    assert.ok(traces.length > 0, `No OTLP traces received:\n${output}`);
    const payload = Buffer.concat(traces);
    assert.ok(payload.includes(Buffer.from('1234567890abcdef1234567890abcdef', 'hex')), 'Incoming trace ID should propagate');
    for (const secret of [sensitiveMessage, apiKey, identityHeader, token]) {
      assert.ok(!payload.includes(Buffer.from(secret)), `OTLP captured sensitive value: ${secret}`);
      assert.ok(!output.includes(secret), `Gateway logs captured sensitive value: ${secret}`);
    }
  });
  await t.test('Entra route rejects invalid JWTs and unauthorized principals without API-key fallback', async () => {
    const count = upstreamRequests.length;
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    for (const [name, credential, status] of [
      ['missing', undefined, 401],
      ['legacy API key', apiKey, 401],
      ['malformed', 'not-a-jwt', 401],
      ['wrong signature', jwt({}, otherKey), 401],
      ['wrong issuer', jwt({ iss: 'https://other-issuer.example' }), 401],
      ['wrong audience', jwt({ aud: 'other-api' }), 401],
      ['expired', jwt({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401],
      ['unknown identity', jwt({ oid: 'other-user' }), 403],
      ['missing delegated scope', jwt({ scp: 'other.scope' }), 403],
      ['missing identity', jwt({ oid: undefined }), 403],
    ]) {
      const response = await completion(credential ? `Bearer ${credential}` : undefined, {}, '/entra/v1/chat/completions');
      assert.equal(response.status, status, `${name}: ${await response.text()}`);
    }
    assert.equal(upstreamRequests.length, count);
  });
  await t.test('delegated users and autonomous agents use gateway identity upstream', async () => {
    for (const claims of [{}, { idtyp: 'app', scp: undefined }]) {
      const callerToken = jwt(claims);
      const response = await completion(`Bearer ${callerToken}`, {}, '/entra/v1/chat/completions');
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).choices[0].message.content, 'Hello tutor');
      const upstream = upstreamRequests.at(-1);
      assert.equal(upstream.headers.authorization, `Bearer ${token}`);
      assert.equal(upstream.url.pathname, '/openai/v1/chat/completions');
      assert.equal(upstream.data.model, 'gpt-5.4-nano');
      assert.ok(!output.includes(callerToken));
    }
  });
  await t.test('Entra route preserves streaming and upstream errors', async () => {
    const authorization = `Bearer ${jwt({ idtyp: 'app', scp: undefined })}`;
    const streamed = await completion(authorization, { stream: true }, '/entra/v1/chat/completions');
    assert.equal(streamed.status, 200, await streamed.clone().text());
    assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
    const events = (await streamed.text()).split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(events.at(-1), 'data: [DONE]');
    const chunks = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content || '').join(''), 'Hello tutor');
    const failed = await completion(authorization, {
      messages: [{ role: 'user', content: 'upstream-error' }],
    }, '/entra/v1/chat/completions');
    assert.equal(failed.status, 429, await failed.text());
  });
  await t.test('delegated route requires the allowed human, agent actor and delegated scope', async () => {
    const count = upstreamRequests.length;
    for (const [name, credential, status] of [
      ['missing token', undefined, 401],
      ['app-only token', jwt({ idtyp: 'app', scp: undefined }), 403],
      ['disallowed user', jwt({ oid: 'other-user' }), 403],
      ['disallowed actor', jwt({ azp: 'other-agent' }), 403],
      ['missing actor', jwt({ azp: undefined }), 403],
      ['missing scope', jwt({ scp: undefined }), 403],
    ]) {
      const response = await completion(
        credential ? `Bearer ${credential}` : undefined, {}, '/delegated/v1/chat/completions',
      );
      assert.equal(response.status, status, `${name}: ${await response.text()}`);
    }
    assert.equal(upstreamRequests.length, count);
    const callerToken = jwt();
    const allowed = await completion(`Bearer ${callerToken}`, {}, '/delegated/v1/chat/completions');
    assert.equal(allowed.status, 200, await allowed.clone().text());
    assert.equal((await allowed.json()).choices[0].message.content, 'Hello tutor');
    assert.equal(upstreamRequests.length, count + 1);
    assert.equal(upstreamRequests.at(-1).headers.authorization, `Bearer ${token}`);
    assert.equal(upstreamRequests.at(-1).url.pathname, '/openai/v1/chat/completions');
    assert.ok(!output.includes(callerToken));
    const streamed = await completion(`Bearer ${callerToken}`, { stream: true }, '/delegated/v1/chat/completions');
    assert.equal(streamed.status, 200);
    assert.ok((await streamed.text()).includes('data: [DONE]'));
    const deniedUpstream = await completion(`Bearer ${callerToken}`, {
      messages: [{ role: 'user', content: 'upstream-error' }],
    }, '/delegated/v1/chat/completions');
    assert.equal(deniedUpstream.status, 429);
    await deniedUpstream.text();
  });
});
