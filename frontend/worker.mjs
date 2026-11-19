// Bitcoin Purity Cloudflare Worker + static assets.
// Preserve same-origin API/WebSocket routes from the legacy Nginx frontend.
const API_ORIGIN = 'https://mempool-api.bitcoinpurity.org';

export async function handleApiRequest(request) {
  const incoming = new URL(request.url);
  const path = incoming.pathname;

  if (!path.startsWith('/api/')) {
    return new Response('Not Found', { status: 404 });
  }

  // Do not expose internal backend or Esplora endpoints through the public edge.
  if (/^\/api\/(?:v1\/)?internal(?:\/|$)/.test(path)) {
    return new Response('Not Found', { status: 404 });
  }

  const isSocket = path === '/api/v1/ws';
  if (isSocket && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }

  const upstream = new URL(incoming.pathname + incoming.search, API_ORIGIN);
  if (isSocket) {
    // Existing Nginx uses proxy_pass http://127.0.0.1:8999/ for /api/v1/ws.
    upstream.pathname = '/';
  } else if (!path.startsWith('/api/v1/')) {
    // Legacy Nginx maps /api/foo to the Purity backend's /api/v1/foo.
    upstream.pathname = path.replace(/^\/api\//, '/api/v1/');
  }

  const proxyRequest = new Request(upstream.toString(), request);
  proxyRequest.headers.delete('host');
  return fetch(proxyRequest);
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) {
      return handleApiRequest(request);
    }
    // Other paths are ordinarily served without invoking this Worker thanks to
    // assets.run_worker_first. This fallback is for direct Worker invocations.
    return env.ASSETS.fetch(request);
  },
};
