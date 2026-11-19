# Independent Signet Cloudflare Tunnel for the Mempool Workers frontend

This is the intended **direct** path for the Signet APIs and WebSocket. It does not proxy through the old `mempool.bitcoinpurity.org` Nginx site.

```
Browser -> mempool-stage.bitcoinpurity.org (Worker)
  /api/*          -> mempool-api.bitcoinpurity.org (existing mainnet LB)
  /signet/api/*   -> signet-api.bitcoinpurity.org (dedicated Tunnel)
                       -> Signet backend HTTP server (e.g. :8995)
```

## Backend prerequisite

Check the actual Signet backend configuration first:

- `MEMPOOL.NETWORK = signet`
- `MEMPOOL.API_URL_PREFIX = /api/v1/` (default)
- `MEMPOOL.BACKEND = electrum` (or another non-`esplora` mode with the built-in Esplora-compatible routes).
- Confirm the HTTP listener and how the `cloudflared` host can reach it. The repository's example Signet upstream uses port **8995**, but this is not proof of the deployed port.

The built-in Signet backend registers `/api/v1/tx/:txId`, `/api/v1/block/:hash`, `/api/v1/address/:address`, etc. only if `MEMPOOL.BACKEND !== 'esplora'`. If it is configured in `esplora` mode, the legacy `/signet/api/*` endpoints require a **separate Esplora Tunnel or gateway**; the single-host setup below is not complete in that case.

Run from the machine hosting Signet Backend:

```sh
curl -fsS http://127.0.0.1:8995/api/v1/blocks/tip/height
curl -fsS http://127.0.0.1:8995/api/v1/init-data | head -c 250; echo
curl -fsS http://127.0.0.1:8995/api/v1/fees/recommended
```

Replace `127.0.0.1:8995` with the actual private service address and port. Do **not** publish this backend's TCP port directly to the Internet.

## Cloudflare Tunnel setup (account dashboard)

1. Under **Networking -> Tunnels**, create a Cloudflare Tunnel named e.g. `purity-signet-api`; or reuse an existing healthy Tunnel on the Signet host. Do not install a second default `cloudflared` systemd service over a currently running service.
2. If creating a new remote-managed tunnel, install `cloudflared` on a host that can reach the Signet backend and follow the dashboard's connector token instructions. Store the token privately; do not commit it to Git.
3. Add a **Published application** route:
   - Public hostname: `signet-api.bitcoinpurity.org`
   - Service type: HTTP
   - Service URL: `http://127.0.0.1:8995` **only if the backend runs locally on the connector host**. If it is on another Tailscale-connected host, use that host's private Tailscale IP and its actual API port, with appropriate Tailscale ACLs.
   - No `/signet` path prefix at the Tunnel layer: the Worker already strips it.
4. The dashboard-managed published route normally creates the matching proxied DNS CNAME automatically. Ensure no conflicting DNS record or Worker Route matches `signet-api.bitcoinpurity.org`.
5. Confirm the Tunnel is connected, the backend service is healthy, and the DNS hostname exists.

**The current Cloudflare WAF rule `mempool-api-block-public` actively blocks direct public requests to `signet-api.bitcoinpurity.org` (alongside `mempool-api.bitcoinpurity.org`). A direct public curl returning HTTP 403 is therefore expected and is not proof of a broken Tunnel. Do not disable the rule merely to test the API.**

Cloudflare's same-zone Worker `fetch()` subrequests to proxied hostnames are **not evaluated by the target hostname's WAF Custom Rules**. Therefore perform end-to-end verification through the Stage Worker after the code is deployed, rather than requiring a direct publicly accessible Signet API.

```sh
curl -i https://mempool-stage.bitcoinpurity.org/signet/api/v1/blocks/tip/height
curl -i https://mempool-stage.bitcoinpurity.org/signet/api/v1/init-data
curl -i https://mempool-stage.bitcoinpurity.org/signet/api/v1/internal/blocks/definition/list
```

The first two responses should be HTTP 200 with real Signet chain data/JSON, and the internal endpoint should be HTTP 404. Any HTTP 403, 502, 530, HTML payload, or request timeout on the first two requires investigation of Tunnel DNS, WAF, service URL or backend status. The public `signet-api` hostname should remain directly blocked.

Official Cloudflare reference: https://developers.cloudflare.com/waf/feature-interoperability/

## Route mapping in the Worker

| Browser path | Tunnel upstream path |
| --- | --- |
| `/signet/api/v1/blocks/tip/height` | `/api/v1/blocks/tip/height` |
| `/signet/api/v1/init-data` | `/api/v1/init-data` |
| `/signet/api/tx/<txid>` | `/api/v1/tx/<txid>` |
| `/signet/api/block/<hash>` | `/api/v1/block/<hash>` |
| `/signet/api/fee-estimates` | `/api/v1/fee-estimates` |
| `/signet/api/v1/ws` (Upgrade: websocket) | `/` (WebSocket handshake) |

The Mempool backend creates a WebSocket server attached to its HTTP server without a path restriction. The existing mainnet proxy already sends websocket upgrades to `/`.

## Access control and operational safety

**Important:** Publishing the backend directly via a Tunnel makes its REST endpoints publicly reachable on `signet-api.bitcoinpurity.org`, even without going through the Stage Worker. **Blocking `/internal/` in the Worker alone is not sufficient.**

Before publishing for general use, set a Cloudflare WAF Custom Rule for the Tunnel hostname to **Block** direct access to at least:

```
(http.host eq "signet-api.bitcoinpurity.org" and
 (http.request.uri.path eq "/api/v1/internal" or
  starts_with(http.request.uri.path, "/api/v1/internal/") or
  http.request.uri.path eq "/api/internal" or
  starts_with(http.request.uri.path, "/api/internal/")))
```

Also review all sensitive routes and add a backend-side allowlist or an Access service-token policy where appropriate. Cloudflare's same-zone Worker subrequests bypass the target WAF custom rules, so keep Worker-side internal blocks as defense in depth. Verify on the public hostname that `/api/v1/internal/blocks/definition/list` is not accessible.

WebSocket validation in the browser: DevTools -> Network -> WS -> `/signet/api/v1/ws` should return **101 Switching Protocols** and receive an `init` payload. A normal HTTP request to the Stage websocket path should return 426.

## Rollback

The mainnet path `/api/*` remains unchanged. Roll back only the Worker deployment or revert the Signet routing commit if the Tunnel is unavailable. Do not modify the existing mainnet LB or its pool steering settings.
