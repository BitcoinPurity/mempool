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


// Return the localized SPA shell for a browser navigation to a deep Angular route.
// Existing files are served by Workers Static Assets before the Worker is invoked;
// only unmatched requests reach this fallback under the current Wrangler config.
export function localizedSpaShell(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const accept = request.headers.get('accept') || '';
  const fetchMode = request.headers.get('sec-fetch-mode') || '';
  if (!accept.includes('text/html') && fetchMode !== 'navigate') return null;

  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/(en-US|[a-z]{2})\/(.+)$/);
  if (!match) return null;
  const route = match[2];

  // Missing static assets and API endpoints must stay 404, never HTML 200.
  if (route.split('/').some(part => part.includes('.'))) return null;
  if (/^(?:api(?:\/|$)|(?:signet|testnet4?|regtest)\/api(?:\/|$))/.test(route)) return null;

  return `/${match[1]}/`;
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) {
      return handleApiRequest(request);
    }
    const shell = localizedSpaShell(request);
    if (shell) {
      const shellUrl = new URL(request.url);
      // Fetch the canonical /<locale>/ directory, not /<locale>/index.html:
      // default Cloudflare html_handling redirects index.html to the directory.
      shellUrl.pathname = shell;
      shellUrl.search = '';
      return env.ASSETS.fetch(new Request(shellUrl, request));
    }

    // Static files and unmatched non-navigation requests retain the original path.
    return env.ASSETS.fetch(request);
  },
};
