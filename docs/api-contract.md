# API 契约

REQ-002 的前端 `PURITY_NODES_MAP_ENABLED` 仅控制首页展示与组件请求，以下后端接口及认证、限流行为保持不变。

## `GET /api/v1/purity/nodes`

成功返回 `{ "updated_at": <Unix秒>, "nodes": [...] }`。仅包含 `status: "purity"` 的记录。每条记录包含 `host`、`port`、`status`、`p2p_reachable`（`1/0/null`）、`user_agent`、`height`、`last_seen`、`last_success`、`last_p2p_success` 及 `location`。

`location` 为 `null` 或 `{ "longitude": number, "latitude": number, "city": string|null, "country": string|null, "country_code": string|null }`。定位失败不删除记录。快照在后端缓存 60 秒，HTTP 响应不缓存，以便添加后读取新快照。上游是认证的 `GET https://seed.bitcoinpurity.org/api/listnodes`，查询超时 15 秒。

REQ-004 新增 `node_type: "archive" | "prune" | "unknown"`，独立于 `p2p_reachable`。根据上游非负安全整数 `services`：有 bit 0（`NODE_NETWORK`）为 `archive`；无 bit 0 但有 bit 10（`NODE_NETWORK_LIMITED`）为 `prune`；否则为 `unknown`。缺失或无法精确读取时也为 `unknown`，不影响库存读取。两个标志同时存在时保留 `archive`，遵循 [BIP159](https://bips.dev/159/)。该字段表示节点声明的服务能力，不表示本项目验证过其磁盘保存范围。其他字段、缓存、认证和添加契约不变。

前端取消节点类型展示后忽略 `node_type`，仅按 `p2p_reachable` 设置标记；后端继续返回该字段，上述 API 契约不变。

## `POST /api/v1/purity/nodes`

请求 JSON `{ "host": "公网IP", "port": 8333 }`，省略 `port` 时为 8333。仅接受公网 IPv4／IPv6 字面地址，不解析域名；端口必须为 1–65535 的整数。成功返回上游的 `{ "host", "port", "added", "verification", "status" }`。

`added=false` 表示端点已存在并再次验证。`verification` 是 `purity`、`other` 或 `inconclusive`；本次验证未完成并不撤销此前确认身份，以后续库存的 `status` 为准。上游调用是认证的 `POST https://seed.bitcoinpurity.org/api/addnode`，超时 60 秒，不自动重试。

错误返回 `{ "error": "错误代码" }`。400：IP／端口无效；429：来源一分钟频率限制或两个并发验证上限（携带 `Retry-After`）；503：未配置 Token 或地理文件不可用；502：Seeder 错误、认证失败或响应契约无效；504：上游超时。响应和日志不包含上游 Authorization 或原始错误对象。HTTP 200 的 `other/inconclusive` 是验证结果，不是传输错误。

## REQ-003：同步诊断

本需求不增删公开端点，不改变请求／响应格式。`GET /api/v1/fees/recommended` 沿用未同步时的 HTTP 503 和正常同步后的成功响应。诊断仅写入现有后端 logger；5 秒阈值只控制日志，不改变 RPC 超时、认证、序列化或结果。Redis 与磁盘缓存格式不变，无数据库迁移。
