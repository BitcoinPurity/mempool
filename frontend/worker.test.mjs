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

test('direct locale deep links receive the matching locale SPA shell', async () => {
  const requested = [];
  const assets = { fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response('<base href="/da/">', { status: 200, headers: { 'Content-Type': 'text/html' } });
  } };
  const hash = '000000000000000094e9b2747e8df6756560591de960c8f31b0a5fd3f140efcb';
  const response = await worker.fetch(
    new Request('https://mempool-stage.bitcoinpurity.org/da/block/' + hash + '?test=1', { headers: { Accept: 'text/html' } }),
    { ASSETS: assets }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ['/da/']);
  assert.match(await response.text(), /base href="\/da\/"/);
});

test('English and Chinese deep links keep their own locale shell', async () => {
  const requested = [];
  const assets = { fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response('ok');
  } };
  for (const localePath of ['/en-US/tx/abc', '/zh/signet/blocks']) {
    const response = await worker.fetch(
      new Request('https://mempool-stage.bitcoinpurity.org' + localePath, { headers: { 'Sec-Fetch-Mode': 'navigate' } }),
      { ASSETS: assets }
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(requested, ['/en-US/', '/zh/']);
});

test('missing scripts, styles, images and non-navigation API paths do not receive HTML', async () => {
  const requested = [];
  const assets = { fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response('missing', { status: 404 });
  } };
  const paths = [
    '/da/main.abcdef.js',
    '/de/styles.aaa.css',
    '/zh/logo.png',
    '/da/signet/api/v1/init-data',
    '/de/block/abc',
    '/resources/not-found.svg'
  ];
  for (const path of paths) {
    const response = await worker.fetch(
      new Request('https://mempool-stage.bitcoinpurity.org' + path, { headers: { Accept: path === '/de/block/abc' ? 'application/json' : 'text/html' } }),
      { ASSETS: assets }
    );
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(requested, paths);
});

test('locale deep route POST does not turn into static SPA HTML', async () => {
  const requested = [];
  const assets = { fetch(request) {
    requested.push(new URL(request.url).pathname);
    return new Response('missing', { status: 404 });
  } };
  const response = await worker.fetch(new Request('https://mempool-stage.bitcoinpurity.org/da/tx/abc', {
    method: 'POST', headers: { Accept: 'text/html' }
  }), { ASSETS: assets });
  assert.equal(response.status, 404);
  assert.deepEqual(requested, ['/da/tx/abc']);
});

test('nonlocalized routes keep existing asset handling', async () => {
  let url = '';
  const response = await worker.fetch(new Request('https://mempool-stage.bitcoinpurity.org/cdn-cgi/trace', {
    headers: { Accept: 'text/html' }
  }), { ASSETS: { fetch(request) { url = new URL(request.url).pathname; return new Response('trace'); } } });
  assert.equal(url, '/cdn-cgi/trace');
  assert.equal(await response.text(), 'trace');
});
