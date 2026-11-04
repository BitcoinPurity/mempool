# API 契约

## REQ-011：Supply Distribution

仅在后端 `SUPPLY_DISTRIBUTION.ENABLED` 且供应库初始化成功时注册；路径带网络前缀（如 `/signet/api/v1/...`）。所有成功响应包含 `status`（`bootstrapping`/`ready`/`stale`）、`height`、`hash`、`updatedAt`（Unix 秒）与 `confirmations`，`Cache-Control: public, max-age=10`。尚无数据时返回 404 `{ "error": "no_data" }`；stale 时照常返回最后数据。金额单位为 sat。

- `GET /api/v1/supply/distribution`：`totalAmount`、`issuedAmount`（创世至 `height` 按发行计划）、`maxSupply`、`utxoCount`、`scriptCount`、`nonZeroScriptCount`、`zeroBalanceScripts`、`buckets[]`（`bucket`、`minSats`、`maxSats|null`、`scriptCount`、`amount`；下界包含）。
- `GET /api/v1/supply/top-addresses?page=1&limit=100`：`limit` 1–100，`(page−1)·limit < TOP_N`，否则 400（`invalid_limit`/`invalid_page`）。返回 `total`（min(TOP_N, scriptCount)）、`page`、`limit`、`totalAmount`、`rows[]`：`rank`、`address|null`（P2PK 为公钥 hex）、`type`、`balance`、`utxoCount`，无地址时附 `script`（前 64 字节 hex）与 `scriptTruncated`。排序为 `balance DESC, script_hash DESC`。
- `GET /api/v1/supply/address/:address`：接受本网络地址或公钥 hex，否则 400 `invalid_address`。在前 TOP_N 内返回 `rank`、`topN`、`balance`、`utxoCount`、`share`（占 `totalAmount` 比例）；否则 404 `not_ranked`。

## REQ-010：Health 与 RPC HTTP 错误

`GET /api/v1/block/:hash/summary` 直接调用 `Blocks.$getStrippedBlockTransactions(hash)`，返回分类交易数组。内存／数据库无当前版本摘要时，会等待完整交易取数、分类和必要的持久化完成；该接口自身不运行 GBT 模板审计。

`GET /api/v1/block/:hash` 返回区块详情，并等待 Health 刷新；历史数据库区块格式化也可能重建旧版分类摘要。摘要缺失／过期时，该接口同样可能等待完整交易取数，沿用现有失败时 Health 为 null 的行为。

Health 继续从区块接口 `extras.matchRate` 读取。`audit-summary` 没有完整模板时仍可返回 404，详情页不再依赖该接口显示 Health，不改变完整审计响应结构。

区块列表仍按高度降序返回，并在响应前完成本批 Health 刷新；内部摘要重建每进程最多 4 个并发，同区块请求合并，当前数据库摘要读取绕过重建队列。公开请求／响应及 Unknown 语义不变。Core／Electrum 内部完整区块 RPC 优先使用 [getblock verbosity=3](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblock/)，复用返回的 prevout；数据缺失保留原查询，明确的无效 verbosity（-8）回退为 2。其他 RPC／HTTP 错误不重试，Liquid 仍为 verbosity=2。

内部 RPC 非 JSON、非 200 响应改为 `code: EHTTP`、`statusCode: <HTTP 状态>`；503 正文准确为 `Work queue depth exceeded` 时保留此固定原因，其余正文不进入错误消息。JSON-RPC 错误码、成功结果、认证和超时不变。

REQ-002 的前端 `PURITY_NODES_MAP_ENABLED` 仅控制首页展示与组件请求，以下后端接口及认证、限流行为保持不变。

## `GET /api/v1/purity/nodes`

成功返回 `{ "updated_at": <Unix秒>, "nodes": [...] }`。仅包含 `status: "purity"` 的记录。每条记录包含 `host`、`port`、`status`、`p2p_reachable`（`1/0/null`）、`user_agent`、`height`、`last_seen`、`last_success`、`last_p2p_success` 及 `location`。

`location` 为 `null` 或 `{ "longitude": number, "latitude": number, "city": string|null, "country": string|null, "country_code": string|null }`。定位失败不删除记录。快照在后端缓存 60 秒，HTTP 响应不缓存，以便添加后读取新快照。上游是认证的 `GET https://seeder.bitcoinpurity.org/api/listnodes`，查询超时 15 秒。

REQ-004 新增 `node_type: "archive" | "prune" | "unknown"`，独立于 `p2p_reachable`。根据上游非负安全整数 `services`：有 bit 0（`NODE_NETWORK`）为 `archive`；无 bit 0 但有 bit 10（`NODE_NETWORK_LIMITED`）为 `prune`；否则为 `unknown`。缺失或无法精确读取时也为 `unknown`，不影响库存读取。两个标志同时存在时保留 `archive`，遵循 [BIP159](https://bips.dev/159/)。该字段表示节点声明的服务能力，不表示本项目验证过其磁盘保存范围。其他字段、缓存、认证和添加契约不变。

前端取消节点类型展示后忽略 `node_type`，仅按 `p2p_reachable` 设置标记；后端继续返回该字段，上述 API 契约不变。

## `POST /api/v1/purity/nodes`

请求 JSON `{ "host": "公网IP", "port": 8333 }`，省略 `port` 时为 8333。仅接受公网 IPv4／IPv6 字面地址，不解析域名；端口必须为 1–65535 的整数。成功返回上游的 `{ "host", "port", "added", "verification", "status" }`。

`added=false` 表示端点已存在并再次验证。`verification` 是 `purity`、`other` 或 `inconclusive`；本次验证未完成并不撤销此前确认身份，以后续库存的 `status` 为准。上游调用是认证的 `POST https://seeder.bitcoinpurity.org/api/addnode`，超时 60 秒，不自动重试。

错误返回 `{ "error": "错误代码" }`。400：IP／端口无效；429：来源一分钟频率限制或两个并发验证上限（携带 `Retry-After`）；503：未配置 Token 或地理文件不可用；502：Seeder 错误、认证失败或响应契约无效；504：上游超时。响应和日志不包含上游 Authorization 或原始错误对象。HTTP 200 的 `other/inconclusive` 是验证结果，不是传输错误。

## REQ-003：同步诊断

本需求不增删公开端点，不改变请求／响应格式。`GET /api/v1/fees/recommended` 沿用未同步时的 HTTP 503 和正常同步后的成功响应。诊断仅写入现有后端 logger；5 秒阈值只控制日志，不改变 RPC 超时、认证、序列化或结果。Redis 与磁盘缓存格式不变，无数据库迁移。

## REQ-005：内部 RPC 传输错误

公开 API 和 RPC 请求／成功响应格式不变。内部 JsonRPC 的 `ETIMEDOUT` 覆盖从请求发起到完整响应结束的总期限，持续分块不会延长期限；socket 空闲超时保留 `ESOCKETTIMEDOUT`。响应中断拒绝为 `ECONNRESET`，响应 `error` 保留原错误。超时值、认证、RPC 错误码及解析错误行为不变。

## REQ-006：`bip110deployment` 永久状态契约

WebSocket `action=init`、`GET /api/v1/init-data` 以及订阅 `blocks` 的新区块消息使用同一个字段：

```json
{
  "bip110deployment": {
    "state": "active",
    "permanent": true,
    "currentHeight": 968113,
    "activationHeight": 961637,
    "expiryHeight": null
  }
}
```

- `state` 仅为 `active` 或 `not_active`：表示当前高度的 **Purity 永久 RDTS**，主网 961637 起 active。`not_active` 不追溯或推测早期 Knots/BIP9 部署状态。
- `permanent` 固定 true：永久规则不会到期，状态可随 IBD／重组高度反映激活边界。
- `currentHeight` 为初始快照内存高度或新区块公告高度。
- `activationHeight` 为已核实的 961637；类型允许 null，前端收到 null 时不显示激活高度。主网实现不返回未经确认的值。
- `expiryHeight` 固定 null。没有 expired、阈值、投票数量、锁定、强制投票或任何倒计时字段。
- 提供器遇到其他网络或未知高度返回 null；沿用快照序列化规则省略该字段。其他网络不显示主网永久状态卡。

字段名保留，载荷已变更，前后端须作为配套版本发布。旧载荷不作静默兼容；第三方消费者应按新类型更新。区块公告、mempool 变更／确认、费用、难度及其他 WebSocket 字段不变。历史 `loadingIndicators['bip110-scan']`、违规标志、区块计数／权重、摘要与徽章契约均不变。


## REQ-007: Signet compatibility

Existing route paths and response fields remain compatible. A Signet process uses the same unprefixed `/api/v1/` routes on port 8998; the existing frontend/reverse proxy maps `/signet/api/...` to that process.

- `GET /api/v1/difficulty-adjustment` and WebSocket difficulty payloads report `algorithm: "legacy"` before computing block 327022 and `"asert"` from that block onward. ASERT retarget height is tip+1, with one remaining block. Signet percentages use the compact-rounded consensus target and its own powLimit.
- At Signet tip 327021, the optional additive field `nextBlockDifficultyIsReference: true` identifies the activation target ceiling. A harder claimed activation target is also acceptable to the full node; equality is required afterward. Historical difficulty/retarget data use observed nBits, never classify a block invalid solely from that activation forecast. This flag is omitted at all other heights and on Mainnet.
- Existing `bip110deployment` payload also supports Signet: `activationHeight: 327022`, `state: "not_active" | "active"`, `permanent: true`, `expiryHeight: null`. Mainnet remains independently fixed at 961637.
- Existing transaction flags and block violation counts remain structural/hypothetical indicators. Accepted pre-fork transactions are not declared consensus-invalid. Signet's selected coinbase witness commitment is exempt from the 83-byte OP_RETURN classifier limit up to 195 bytes after activation.
- Incorrect Signet sources abort startup. If periodic validation fails after startup, HTTP returns 503 and WebSockets disconnect (1013); retries can restore service. Sources below activation are pending, logged as such and allowed to synchronize. RPC or Electrum IBD below activation does not produce an activation-hash mismatch. No new identity endpoint is added.

See [operational validation](purity-signet.md) for direct RPC/Electrum checks. No database or existing block/transaction API shape changes are required.


## REQ-008: GitHub-hosted CI

No application API changes. CI listens to main pushes and PR updates and runs the deterministic Signet regression suite without node credentials.

## REQ-009：Health 与数据交易标记

接口路径和响应结构不变，`extras.matchRate`／审计 `matchRate` 仍为非垃圾交易权重占比的百分数，保留两位小数，Coinbase 计入总权重但不计入垃圾权重。普通 OP_RETURN 不再降低分数。新增分类位 `op_return_spam = 2^30`、`op_drop = 2^31`，原 `op_return = 2^24` 继续表示存在 OP_RETURN 输出，不再等价于垃圾。所有分类位保持既有数值；消费者应使用 BigInt 掩码，避免高位截断。

OP_RETURN 垃圾条件为任一输出累计数据载荷超过 80 字节或多于一个 OP_RETURN 输出。同址转账与地址复用本身不构成垃圾交易。OP_DROP 位表示可见脚本中直接压入并立即 DROP／2DROP 的累计数据超过 80 字节，排除 CLTV/CSV 参数清理。隐藏脚本未揭示前不推断；该指标不表示共识有效性。

摘要分类版本升级为 6，撤销版本 5 的同址垃圾判断。过期摘要按需重建，历史分数随摘要重分类更新；尚未访问／后台重分类的历史数据库行与聚合图表可能暂时保留旧分数。重分类失败时区块查询不继续返回缓存旧分数，显示未知。前端原始交易本地解码不新增这两项启发式检测；新垃圾标签来自后端分类，普通 OP_RETURN 类型标签保持可用。
