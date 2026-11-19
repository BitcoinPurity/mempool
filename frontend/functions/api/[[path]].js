// Cloudflare Pages: same-origin proxy to the existing Purity mainnet API load balancer.
// Cloudflare Pages root directory is "frontend".
const UPSTREAM_ORIGIN = "https://mempool-api.bitcoinpurity.org";

export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  const pathname = incoming.pathname;

  // The public Pages endpoint must not expose internal backend APIs.
  if (/^\/api\/(?:v1\/)?internal(?:\/|$)/.test(pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  const isWebSocket = pathname === "/api/v1/ws";
  if (isWebSocket && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  const upstream = new URL(incoming.pathname + incoming.search, UPSTREAM_ORIGIN);
  if (isWebSocket) {
    // Existing Nginx proxy_pass ...:8999/ sends /api/v1/ws to backend root.
    upstream.pathname = "/";
  } else if (!pathname.startsWith("/api/v1/")) {
    // Match the current Purity Nginx proxy: /api/foo -> /api/v1/foo.
    upstream.pathname = pathname.replace(/^\/api\//, "/api/v1/");
  }

  // Preserve method, request body, query, and WebSocket Upgrade headers.
  const upstreamRequest = new Request(upstream.toString(), request);
  upstreamRequest.headers.delete("host");
  return fetch(upstreamRequest);
}
