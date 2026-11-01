# Purity Mainnet and Signet backends

One compiled backend supports two independent processes. Network is selected by the JSON configuration's `MEMPOOL.NETWORK`; a bare `NETWORK=signet` environment variable is not read. Set `MEMPOOL_CONFIG_FILE` to an **absolute path**. Keep existing Mainnet configuration and data unchanged.

The [technical assessment and verification](tasks/TASK-007.md) records the source audit. Consensus reference: [v1.1.0 official release and Signet profile](https://github.com/saltduck/bitcoinpurity/releases/tag/v1.1.0), [pow.cpp](https://github.com/saltduck/bitcoinpurity/blob/443f3bfec747fd4e865001741aeda243fcad3fec/src/pow.cpp), [consensus tests](https://github.com/saltduck/bitcoinpurity/blob/443f3bfec747fd4e865001741aeda243fcad3fec/src/test/pow_tests.cpp). Master at that revision has no changes to these rules relative to v1.1.0.

| Setting | Mainnet | Official Purity Signet |
| --- | --- | --- |
| Network | `mainnet` | `signet` |
| HTTP port | 8999 | 8998 |
| Database | `mempool` | `mempool_signet` |
| Default cache | `./cache` | `./cache/signet` |
| RPC port | 8332 | 38332 |
| Electrum | Existing Mainnet Fulcrum configuration | `127.0.0.1:60601`, plain TCP |
| Explorer ASERT activation | 961636 (existing deployed default) | 327022 |
| Anchor height | 961632, bits/time loaded from node | 327017 |
| Anchor nBits | From Mainnet anchor header | `0x1d154f9b` (JSON number 487935899) |
| Anchor **parent** time | From Mainnet anchor parent | 1792401042 |
| Half-life / target spacing | 86400 / 600 seconds | 86400 / 600 seconds |
| powLimit | `00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | `00000377ae000000000000000000000000000000000000000000000000000000` |
| Permanent RDTS activation | 961637 (node consensus) | 327022 |

The Mainnet ASERT estimate default intentionally remains one block earlier than the node's permanent RDTS activation, preserving existing behavior. Existing `PURITY.ACTIVATION_HEIGHT` and `PURITY.ASERT_ANCHOR_HEIGHT` overrides remain supported on Mainnet. Mainnet anchor bits/time are read from the full node. Signet uses the complete official profile automatically, or accepts those exact values explicitly in `PURITY`. Mismatches, invalid heights, missing paired anchor bits/time, malformed targets and incompatible limits are rejected at configuration load. Custom/simulation Signet profiles are outside this configuration's scope. Do not copy a Mainnet `PURITY` section into Signet.

Both ASERT functions use signed division toward zero and the same integer polynomial. Signet requires a wider target domain: its powLimit is 234 bits, while the Mainnet C++ function asserts a maximum of 224 bits. Height difference is `previousHeight - anchorHeight`; time difference is `previousTime - anchorParentTime`; the exponent subtracts `600 * (heightDifference + 1)`. Predictions for Signet are rounded through compact nBits before calculating the difficulty percentage. Legacy 2016-block adjustment applies before activation; Signet does not have Testnet's delayed-block minimum difficulty exception.

At height 327022 only, the node accepts a claimed target **less than or equal to** the compact ASERT reference target (harder work is allowed). Afterward nBits must match exactly. The difficulty-adjustment API at tip 327021 reports `algorithm: "asert"`, `nextRetargetHeight: 327022` and `nextBlockDifficultyIsReference: true`. Its percentage describes the reference target, not the only acceptable activation nBits. Once mined, difficulty history and previous-retarget statistics always use the **observed** header nBits. The official 327022 header happens to equal the reference; deterministic C++ fixtures also cover the harder-target exception.

## Node and Electrs

Use a Bitcoin Purity full node with the **official** `signet-params-official.json` from the release, including the public keys and pinned activation hash. Save valid JSON locally (the release prose example contains a trailing comma after its seed address; remove that comma). The backend example is a different configuration file and cannot replace the node's Signet profile.

Example node `bitcoin.conf` (adapt local paths; retain the official public seed settings):

```ini
chain=signet
signetparams=/etc/bitcoin-purity/signet-params-official.json
[signet]
server=1
assumevalid=0
prune=0
txindex=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=38332
```

Electrs 0.11.1 example:

```toml
network = "signet"
daemon_dir = "/var/lib/bitcoin-purity"
daemon_rpc_addr = "127.0.0.1:38332"
daemon_p2p_addr = "127.0.0.1:38333"
electrum_rpc_addr = "127.0.0.1:60601"
db_dir = "/var/lib/electrs-purity-signet"
```

Electrs must index this Purity node, with a separate DB directory from every other network. These backend changes do not modify or certify Electrs' P2P behavior across the fork; verify its indexed activation header as shown below. Enable `txindex=1` for historical RPC transaction retrieval. The backend's Electrum implementation uses Electrs for address indexes and Core RPC for blocks and transaction details. Cookie authentication requires local read access to the node's **Signet** cookie for both processes; grant that access locally, or configure a dedicated RPC user in the private backend configuration. Do not copy cookie contents into Git or expose the RPC/Electrum listeners publicly.

## Contabo EU example (4 vCPU / 8 GB / 100 GB)

Use [backend/mempool-config.purity-signet.example.json](../backend/mempool-config.purity-signet.example.json). It disables expensive summaries, goggles, CPFP, cluster indexing, Lightning and fiat updates, polls every five seconds, indexes 2048 blocks and uses ten DB connections. These are initial resource settings, not a measured capacity guarantee for the combined node, Electrs and MariaDB workload.

Create a separate local service account, database and directories. The example uses MariaDB `unix_socket` authentication, so its empty password is intentional and requires the service account to match the database username:

```sh
sudo useradd --system --home-dir /var/lib/mempool-signet --shell /usr/sbin/nologin mempool_signet
sudo install -d -o mempool_signet -g mempool_signet /var/lib/mempool-signet/cache
sudo install -d -m 0750 /etc/mempool
sudo install -m 0640 -o root -g mempool_signet backend/mempool-config.purity-signet.example.json /etc/mempool/purity-signet.json
sudo mariadb <<'SQL'
CREATE DATABASE mempool_signet;
CREATE USER 'mempool_signet'@'localhost' IDENTIFIED VIA unix_socket;
GRANT ALL PRIVILEGES ON mempool_signet.* TO 'mempool_signet'@'localhost';
SQL
```

Adapt cookie and socket paths to the actual host before starting. Keep Mainnet's DB/user and writable paths separate. Use a fresh Signet DB/cache/Redis namespace; never import Bitcoin Core Signet post-fork data or a Mainnet database. The backend detects the two built-in state collisions (`DATABASE=mempool` and `CACHE_DIR=./cache`) on Signet. Custom paths/databases still require operator separation, including avoiding symlinks pointing at the same directory. PID filenames already include the DB name (`mempool-mempool.pid` versus `mempool-mempool_signet.pid`). Redis, if enabled, uses DB 0 for Mainnet and DB 2 for Signet; the example disables it.

Build once in the backend directory with `npm ci` (including the repository's native GBT build) and `npm run build`. Use a Node version compatible with the locked dependencies. Existing Mainnet configuration continues to use `NETWORK=mainnet`, `HTTP_PORT=8999`, database `mempool` and its own RPC/Fulcrum settings.

Example `/etc/systemd/system/mempool-signet.service`, assuming the repository is installed at `/opt/mempool` and Node at `/usr/bin/node`:

```ini
[Unit]
Description=Bitcoin Purity Signet explorer backend
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
User=mempool_signet
Group=mempool_signet
WorkingDirectory=/opt/mempool/backend
Environment=MEMPOOL_CONFIG_FILE=/etc/mempool/purity-signet.json
ExecStart=/usr/bin/node --max-old-space-size=2048 /opt/mempool/backend/dist/index.js
RuntimeDirectory=mempool-signet
RuntimeDirectoryMode=0750
Restart=on-failure
RestartSec=10
UMask=0027

[Install]
WantedBy=multi-user.target
```

The node and Electrs services must be running first; add their **actual installed unit names** as dependencies if desired. A second existing Mainnet service can run the same `dist/index.js` with `MEMPOOL_CONFIG_FILE=/etc/mempool/mainnet.json`, its original port/DB/cache, and a separate runtime directory. Do not change a running Mainnet service just to add Signet. Review the files, then start only the Signet service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mempool-signet.service
sudo journalctl -u mempool-signet.service -n 80 --no-pager
curl --fail http://127.0.0.1:8998/api/v1/difficulty-adjustment
```

Preserve separate reverse-proxy upstreams and caches. The existing `/signet/api/...` routing can point at 8998 while `/api/...` stays on 8999 (see `production/nginx/location-signet-api.conf`). Enable the existing frontend Signet network option when that upstream is ready; no new frontend architecture is required. The backend listens as the existing application does; bind access through the host firewall/reverse proxy.

## Chain identity and synchronization

The shared genesis hash and `getblockchaininfo.chain == "signet"` cannot identify Purity after the fork. Before serving HTTP or WebSocket data, and at every update-loop iteration, the backend checks the official activation hash on **both** RPC and the configured indexer. Electrum uses protocol 1.4 `blockchain.block.header`, hashes the actual 80-byte header and compares it with:

```text
327022: 00000004b42cf68f94be9dd89b65e44cae31eee382137221b83b5b261d3e3c20
```

Below activation, startup proceeds with a warning: `Purity Signet identity pending`. This is shared history and does not prove the post-fork identity. If Core or Electrs is still below activation, the status stays pending; each source is checked as soon as it reaches activation, independently of the node's IBD flag. A mismatch at startup aborts before DB/cache loading and listening. During operation, a failed check suspends ingestion, HTTP returns 503, and WebSocket clients are disconnected; normal retries can recover after the source is corrected. Already-running requests are not cancelled. Checks occur once per poll, not atomically for every individual data read.

Verify manually without exposing credentials (the CLI reads its local configuration):

```sh
bitcoin-cli -signet -datadir=/var/lib/bitcoin-purity getblockchaininfo
bitcoin-cli -signet -datadir=/var/lib/bitcoin-purity getblockhash 327022
python3 - <<'PY'
import hashlib, json, socket
with socket.create_connection(('127.0.0.1', 60601), timeout=10) as conn:
    stream = conn.makefile('rwb')
    for rid, method, params in [(1, 'server.version', ['purity-check', '1.4']),
                                (2, 'blockchain.block.header', [327022])]:
        stream.write((json.dumps({'id': rid, 'method': method, 'params': params}) + '\n').encode())
        stream.flush()
        response = json.loads(stream.readline())
        if response.get('error'):
            raise SystemExit(response['error'])
    header = bytes.fromhex(response['result'])
    actual = hashlib.sha256(hashlib.sha256(header).digest()).digest()[::-1].hex()
    expected = '00000004b42cf68f94be9dd89b65e44cae31eee382137221b83b5b261d3e3c20'
    assert len(header) == 80 and actual == expected, actual
    print('Electrs Purity Signet activation hash verified:', actual)
PY
```

Before height 327022 the second RPC and Electrum header query are expected to be unavailable; wait for synchronization, rather than changing the expected hash. Check log transition to `activation hash verified on RPC and indexer`. Normal chain/reorg validation remains the full node's responsibility.

## RDTS, mining and history

RDTS status now reports Signet activation at 327022 and follows reorgs below that boundary. Version bit 4 remains a historical signaling indicator, not a requirement for an accepted post-fork header. Structural BIP110 flags intentionally remain visible for historical transactions: they describe hypothetical rule violations, not proof that a confirmed transaction was invalid. The classifier lacks full spent-output creation-height and script-execution context. Signet transaction warnings state this distinction. The selected post-activation coinbase witness commitment is exempt from the generic 83-byte OP_RETURN check up to the consensus 195-byte limit; the node validates its signatures and encoding. Other outputs retain the usual structural checks.

Observed block difficulties and getnetworkhashps drive mining statistics. Actual coinbase values and fees drive reward/subsidy statistics. Signet retains its historical 210000-block halvings. No Mainnet constant is substituted for a Signet block target. Historical difficulty indexing already records consecutive nBits changes, including every ASERT change; SQL/API shapes are unchanged. No database migration or Mainnet reindex is required.

Ordinary CI uses the committed public header fixtures and C++ reference vectors and needs no node/network access. The Contabo service, MariaDB authentication, full node and Electrs synchronization still need deployment acceptance on that host; this change does not deploy them.
