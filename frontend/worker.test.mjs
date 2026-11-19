import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleApiRequest } from './worker.mjs';

async function captureRequest(request) {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (req) => {
    captured = req;
    return new Response('proxied', { status: 200 });
  };
  try {
    const response = await handleApiRequest(request);
    return { response, captured };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('v1 API routes are retained with query parameters', async () => {
  const { captured, response } = await captureRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/v1/init-data?foo=bar'));
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://mempool-api.bitcoinpurity.org/api/v1/init-data?foo=bar');
});

test('legacy API routes are mapped to v1 and POST bodies preserved', async () => {
  const { captured } = await captureRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/tx?x=y', { method: 'POST', body: 'deadbeef' }));
  assert.equal(captured.url, 'https://mempool-api.bitcoinpurity.org/api/v1/tx?x=y');
  assert.equal(captured.method, 'POST');
  assert.equal(await captured.text(), 'deadbeef');
});

test('WebSocket probes without Upgrade respond with 426', async () => {
  const response = await handleApiRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/v1/ws'));
  assert.equal(response.status, 426);
});

test('WebSocket upgrade targets the backend root', async () => {
  const { captured } = await captureRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/v1/ws', { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } }));
  assert.equal(captured.url, 'https://mempool-api.bitcoinpurity.org/');
  assert.equal(captured.headers.get('upgrade'), 'websocket');
});

test('internal endpoint is rejected at the Worker', async () => {
  const a = await handleApiRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/v1/internal/foo'));
  const b = await handleApiRequest(new Request('https://mempool-stage.bitcoinpurity.org/api/internal/foo'));
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
});

test('other routes fall back to the assets binding', async () => {
  let called = false;
  const reply = await worker.fetch(new Request('https://mempool-stage.bitcoinpurity.org/zh/'), { ASSETS: { fetch() { called = true; return new Response('html'); } } });
  assert.equal(called, true);
  assert.equal(await reply.text(), 'html');
});
