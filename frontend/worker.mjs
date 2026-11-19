// Bitcoin Purity Cloudflare Worker + static assets.
// Preserve same-origin API/WebSocket routes from the legacy Nginx frontend.
const API_ORIGIN = 'https://mempool-api.bitcoinpurity.org';
// Dedicated Cloudflare Tunnel public hostname targeting the Signet backend.
// Never route Signet via the mainnet LB or the legacy mempool Nginx frontend.
const SIGNET_API_ORIGIN = 'https://signet-api.bitcoinpurity.org';

export async function handleApiRequest(request) {
  const incoming = new URL(request.url);
  const path = incoming.pathname;

  const isSignet = path.startsWith('/signet/api/');
  if (!path.startsWith('/api/') && !isSignet) {
    return new Response('Not Found', { status: 404 });
  }

  // Remove the /signet network prefix before forwarding to the independent
  // Signet backend, whose API namespace is /api/v1/ like mainnet.
  const backendPath = isSignet ? path.slice('/signet'.length) : path;

  // Keep internal endpoints inaccessible through either public frontend route.
  if (/^\/api\/(?:v1\/)?internal(?:\/|$)/.test(backendPath)) {
    return new Response('Not Found', { status: 404 });
  }

  const isSocket = backendPath === '/api/v1/ws';
  if (isSocket && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }

  const upstream = new URL(incoming.search || '', isSignet ? SIGNET_API_ORIGIN : API_ORIGIN);
  if (isSocket) {
    // The Mempool backend's ws.Server listens on its HTTP server (any URL).
    upstream.pathname = '/';
  } else if (backendPath.startsWith('/api/v1/')) {
    upstream.pathname = backendPath;
  } else {
    // For a Signet backend in electrum mode, Esplora-like REST endpoints
    // are also exposed under /api/v1/: /signet/api/tx/... -> /api/v1/tx/...
    upstream.pathname = backendPath.replace(/^\/api\//, '/api/v1/');
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
    if (pathname.startsWith('/api/') || pathname.startsWith('/signet/api/')) {
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
