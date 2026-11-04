# 架构

## REQ-011：Supply Distribution

模块位于 `backend/src/api/supply/`。键为 `sha256(scriptPubKey)`；按 Core `IsUnspendable` 排除 OP_RETURN 与超过 10000 字节的输出，使结果与快照和 coinstatsindex 一致。

**引导**：`supply_state` 为空时，`SupplyBootstrap` 检查节点已同步，调用 `dumptxoutset <SNAPSHOT_DIR>/purity-supply-utxo-<ts>.dat latest`（独立 RPC 客户端，`DUMP_TIMEOUT` 默认 3 小时）。worker 线程（`supply-bootstrap-worker.ts`）流式解析 Core 28+ v2 快照（magic、版本、network magic、base hash、coins_count；txid 分组；VARINT、CompressAmount、ScriptCompression），与 RPC 返回的 `base_hash`、`coins_written` 核对。第一遍按压缩脚本键的 FNV 哈希写入 256 个分区文件（JS Map 上限约 1670 万条），第二遍逐分区聚合、还原脚本（非压缩 P2PK 用 BigInt 求 y），分批（5000 行／2MB）写入无二级索引的 `supply_balances_new`，最后建 `(balance, script_hash)` 索引。主线程 `RENAME TABLE` 换表后在一个事务中写入 `supply_buckets` 与 `supply_state`（status=bootstrapping）。换表与写状态之间中断时状态仍为空，下次启动重新引导。失败后最多每 6 小时重试；成功后不再自动引导。快照与分区文件只删除本模块命名的文件。

**逐块跟随**：`SupplyFollower` 仅在单进程或集群 workerId 0 中运行，10 秒一轮、单飞。每轮先检查 `getblockhash(state.height) === state.hash`，不一致时对已存区块调用 `getblock(hash, 3)` 取 prevout，按相反 delta 撤销并退回父块，直到回到主链。随后当 `state.height < tip − CONFIRMATIONS` 时逐块前进：校验新块 `previousblockhash`，经 `bitcoinCoreApi.$getTxsForBlock`（verbosity=3）构建净 delta。`planDeltaApplication` 是纯函数，计算新余额、需写／删的行、区间与总量；仓库在一个事务内 `SELECT … FOR UPDATE`、upsert／delete、更新区间与状态，状态与数据同事务，崩溃后可续。余额为负等不一致抛 `SupplyInconsistencyError` → stale；状态不匹配视为冲突重试；RPC 等瞬时错误下轮重试。coinstatsindex 覆盖该高度时比较 `txouts` 与 `total_amount`（允许 1 sat 浮点误差），不一致 → stale。快照高度满 CONFIRMATIONS 后 status 改为 ready。

**存储**：`DB` 构造函数接受 `{ database }`，复用主库主机与凭据。供应库 schema 由 `supply-database.ts` 自管（`supply_schema_version`），不修改 `database-migration.ts`。初始化失败只禁用本功能并记录错误。

**API 与前端**：路由在本进程按数据高度缓存 Top N 门槛行，地址排名仅对门槛内地址做两次索引计数。地址编码用 bitcoinjs 的纯函数（主网 `bitcoin`，Signet `testnet`）。前端组件在 graphs 模块中，路由仅在 `window.__env.SUPPLY_DISTRIBUTION_NETWORKS`（逗号分隔，如 `signet` 或 `mainnet,signet`）非空时注册，并由守卫限制到所列网络，导航与地址页排名同样只在所列网络显示；订阅 `chainTip$` 去抖 5 秒重新拉取，高度不变不重绘。 持有集中度按数据高度缓存：一次 `SELECT balance … ORDER BY balance DESC, script_hash DESC LIMIT TOP_N`（覆盖索引）后由纯函数 `holderTiers` 分层。页面文字用 `@@supply.*` 标识，翻译写入 `messages.xlf` 与构建的 33 个 `messages.<lang>.xlf`。

## REQ-010：轻量 Health 展示与重建排队

详情页的 Health 独立于 `blockAudit` 和模板可用性；优先使用区块 extras，同块审计分数可回退。可选审计查询的 404 不设置概览错误，其他错误仍保留。审计接口继续表示有模板的完整审计，不修改 JOIN 或创建空模板。

`Blocks` 使用现有 pLimit(4) 限制历史摘要重建，以区块哈希合并在途请求，finally 清理失败及成功任务。数据库摘要查找也包含在去重 Promise 内，但在进入重建队列前执行，因此当前版本的内存／数据库摘要命中与已有 CPFP 的新区块不等待历史任务。`$getBlocks` 收集 Health 刷新 Promise，在返回前统一等待，保留原有区块获取顺序。该限制是每进程的摘要级限制，不是所有 RPC 的全局限流；不改变既有 Esplora 后台分类循环。

区块详情 `$getBlock` 在返回前等待 `$refreshBlockHealth`。数据库路径 `$indexBlock` → `BlocksRepository.$getBlockByHash` → `formatDbBlockIntoExtendedBlock` 还可能为了旧版分类标志重建摘要，缺失费用字段时也可能取完整区块。因此详情与 summary 都可能等待完整交易取数，不能将详情接口简单视为区块头读取；本次保留返回有效 Health／分类的语义，共用上述摘要取数优化。

`BitcoinApi.$getTxsForBlock` 在非 Liquid 网络使用 getblock verbosity=3。交易输出和输入 prevout 共用原有输出转换规则；`$calculateFeeFromInputs` 优先使用已带回的 prevout，仅查询缺失项，再按原方式补内部脚本及计算手续费。节点明确以 RPC -8 拒绝 verbosity 时回退为 2；传输错误和其他 RPC 错误直接传播。Electrum 继承此路径，Liquid 保留 verbosity=2。无 undo 数据的历史块仍可能需要较多 RPC，未引入无限并发、线程池或额外配置。

RPC 传输层区分 HTTP 错误与 JSON-RPC 错误，避免把非 JSON 503 标成无效参数。

## Purity 节点地图

首页地图组件通过现有 ApiService 请求本项目后端。后端通过固定配置的 Seeder 地址（默认 `https://seeder.bitcoinpurity.org`）和环境变量 `PURITY_SEEDER_API_TOKEN` 调用库存及添加 API；前端不接触 Token。节点库存不存入本项目数据库，使用 60 秒内存快照，并合并并发读取。添加完成（包括上游错误／超时）使快照失效；旧的在途查询不能覆盖新快照。

位置由 `MAXMIND.GEOLITE2_CITY` 指定的本地文件提供，仅需 City 数据库，不依赖 Lightning、ASN 或数据库索引功能。文件读取器延迟打开并复用；缺失文件给出明确服务错误。某 IP 无位置时返回 `location: null`。

公开写接口仅接受公网 IP 和合法整数端口。来源默认为 TCP 远端地址；来自 `PURITY_SEEDER.TRUSTED_PROXIES` 中地址的请求才使用 Nginx 覆盖的 `X-Real-IP`。本地 Unix socket 也可接受该代理头。来源每分钟一次、每进程两个并发请求，响应 429 表示受限。

界面每分钟查询一次，销毁时停止计时和请求。ECharts 两个散点系列在本地世界底图显示节点；原始客户端字符串作为文本呈现，不插入 HTML。分类保留 `0` 与 `null` 的差别，不从入站证据推断端口公开性。

REQ-004：后端从 Seeder 的 `services` 推导 `node_type`，优先检查 `NODE_NETWORK`（1），然后检查 `NODE_NETWORK_LIMITED`（1024）。服务标志缺失、不是非负安全整数或没有相关位时返回 `unknown`，此后端逻辑和响应契约不变。前端不消费 `node_type`，仅按可访问状态使用绿色实心圆／橙色空心菱形及系列绘制层级，可访问系列始终在上层。同坐标的可见节点在像素空间展开，不改变 GeoIP 经纬度；筛选后只剩一个节点时将偏移显式重置为零。

`StateService.env.PURITY_NODES_MAP_ENABLED` 默认 `true`。首页模板同时检查主网和该开关；关闭时不实例化地图组件，因此不会打开节点刷新订阅。开关沿用 `mempool-frontend-config.json` → `window.__env` 的配置流程；Docker 入口脚本提供同名环境变量默认值并导出模板占位符。后端无需增加开关。

## REQ-003：同步缓存、计时与 watchdog

`BitcoinApi.rawMempoolCachePromise` 持有完整初始化链：RPC → 写入 `rawMempoolCache` → 记录耗时 → finally 清理在途引用。全部调用者 await 该链，失败不会留下拒绝 Promise，也不创建脱离调用者的清理链。Electrum 继承此逻辑；不同 API 实例各有缓存。缓存快照生命周期和手续费回退不变。

原始 `getrawtransaction` RPC 使用 finally 单独测量，包含成功／失败两条路径，耗时达到 5 秒时警告。该计时不含后续交易转换或手续费元数据查询。TransactionUtils 在进入并发限制器后计时完整抓取，仍使用并发 8 和 allSettled：成功结果顺序及失败过滤不变；汇总 slow、max_fetch、整体耗时、ETIMEDOUT、ESOCKETTIMEDOUT、RPC -5 和其他错误数。max_fetch 包含转换／手续费等待，不含排队，批次总耗时包含排队。

Mempool 按同一输入快照计算缺失／过期数量；初始 info、稳定周期 debug、慢批次或失败 warn。批次调用前记录开始，调用后记录结果或中止；watchdog 在调用前设置实际阶段，阶段切换记录上一阶段耗时和累计耗时。逐笔 Redis 添加使用同一阶段，不逐笔输出阶段日志。刷新 Redis、删除过期 Redis 交易和更新 RBF 缓存各有阶段。最外层 try/finally 仅负责清理 watchdog，原状态更新、缓存、回调和异常传播顺序保留。

入口仍在恢复磁盘／Redis 缓存后启动串行主循环；`getrawmempool()`、区块更新发生在 `$updateMempool()` 之外，其时间不计入此方法的 watchdog。磁盘缓存的“Loaded”日志原本只计文件读取／解析，后面的 `$setMempool()`、回调和 RBF 恢复不在该计时中。本次不修改恢复流程。

## REQ-005：JsonRPC 响应生命周期

请求总计时器在收到响应头后继续运行，直到响应体 `end` 或请求失败。总超时、socket 空闲超时、请求 `error`、响应 `error` 和 `aborted` 共用拒绝逻辑：通过现有 `cbCalled` 防止重复完成，清理计时器、销毁请求、拒绝 Promise。响应 `aborted` 使用 `ECONNRESET`；正常 `end` 清理计时器后沿用原有 JSON 解析和 RPC 结果处理。

不新增计时器、重试、连接池或配置，不改变 BitcoinApi 共享初始化逻辑。传输错误使共享 Promise 正常拒绝，由原有 finally 清理在途状态。

## REQ-006：永久 RDTS 状态

`backend/src/api/bip110-deployment.ts` 保留原模块路径，内容替换为 `PurityReducedDataApi.getStatus(currentHeight?)`。默认高度来自 `blocks.getCurrentBlockHeight()`；新区块回调直接传入公告高度，避免依赖缓存更新顺序。主网固定 RDTS 激活高度 961637，返回同步状态；未知高度（负数）或其他网络返回 null。无需缓存失效、onNewBlock、版本位阈值或磁盘／数据库访问。

WebsocketHandler 初始快照构建改为同步；新区块在更新 `/api/v1/init-data` 共享快照时生成状态，并向 `want-blocks` 客户端发送相同状态。保留 wire 字段名 `bip110deployment`，前端经 WebsocketService → `StateService.purityReducedData$` → 原组件显示永久规则。旧组件在基线未挂载；本次在主网首页费用／难度卡之后挂载紧凑状态卡。

历史分类仍由 Common 的交易标志检测、Blocks 的摘要／计数更新、原历史分类扫描及前端 Bip110Service／区块徽章处理。组件继续读取 `loadingIndicators['bip110-scan']`；这与已删除的临时部署周期扫描无关。ASERT 配置、版本数据、数据库结构与历史记录保持不变。


## REQ-007: Network consensus and Signet identity

`backend/src/purity-config.ts` resolves and validates the official Signet profile before merging generic defaults; existing Mainnet height overrides remain. The pure ASERT API retains its signatures and Mainnet default powLimit. Signet callers supply the wider powLimit and use the fixed anchor parent time. Signet difficulty percentages use compact-rounded targets, and the activation forecast is explicitly marked as a reference. Other Bitcoin test networks no longer accidentally activate Purity ASERT at the Mainnet height.

`PuritySignetValidator` gates startup before database/cache initialization and HTTP/WebSocket listening. Every update-loop iteration rechecks RPC chain/activation hash and the indexer's actual activation header. Below activation, each source is pending and IBD may continue. A later validation failure stops ingestion, gates HTTP with 503 and closes WebSockets; retries can recover. Electrum checks wait for initial protocol negotiation and have a bounded 30-second timeout. Existing in-flight operations are not cancelled; validation is periodic, not atomic with every read.

Mainnet keeps its cache/database/port defaults. Signet defaults to cache/signet, mempool_signet and port 8998, and rejects the standard Mainnet cache/database collision. PID locks already include the database name; Redis already assigns separate network DBs. Operators must use separate custom writable paths, sockets and fresh databases. No schema migration is added. RDTS status includes Signet, historical flags remain hypothetical, and only Signet's selected post-activation coinbase commitment gets the 195-byte structural-classification exception. Mainnet classification version and behavior remain unchanged. See [operations](purity-signet.md) and [TASK-007](tasks/TASK-007.md).


## REQ-008: GitHub-hosted CI

Hosted CI uses fresh Ubuntu runners; the Signet suite has no live-node dependency. Existing build, lint, unit, MariaDB, Docker and browser checks remain. Workflow contract tests check runner and event configuration.

## REQ-009：数据交易分类与 Health

`Common.getDataCarrierFlags` 在静态分类缓存返回前重新计算 OP_RETURN 垃圾条件及 OP_DROP 数据模式，因此从旧缓存恢复的普通 OP_RETURN 不会沿用 `spam=true`。`getScriptDataUsage` 使用 bitcoinjs 脚本解码区分 push 内容与操作码，累计载荷和直接 DROP／2DROP 消耗的数据。P2SH 使用 scriptSig 最后一个 push 恢复 redeemScript；嵌套 P2WSH 只扫描 `0020` witness program 对应的 witnessScript；Taproot 只扫描已揭示、具有已知叶版本与正确控制块长度的叶脚本。未知前序输出时只从明确的 Taproot witness 结构尝试恢复，不把其他 witness 内容猜作脚本。

普通 `op_return` 标签与 `op_return_spam` 分离，新增 `op_drop` 标签；前端将普通 OP_RETURN 归于 Features，Spam 筛选使用新标签。后端 `SPAM_FLAGS` 是完整交易布尔值和分类摘要 Health 的共同依据。其他垃圾类型及 BIP110 检测不变。

摘要分类版本统一为 6，撤销版本 5 的同址 OP_RETURN 垃圾判定；只按 OP_RETURN 数据长度和输出数量判断该类别。恢复有效摘要时同步内存 Health，过期摘要清空旧分数；区块详情和列表在需要时重新分类。按需重建及现有 Esplora 后台分类流程更新 `blocks_audits.match_rate`，保留模板、交易审计列表和预期费用／权重。先更新已有分数，再保存新摘要版本，避免分数写入失败后因摘要已升级而无法重试。不增加数据库 schema 或启动时全量扫描。
