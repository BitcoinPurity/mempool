# 架构

## Purity 节点地图

首页地图组件通过现有 ApiService 请求本项目后端。后端通过固定配置的 Seeder 地址和环境变量 `PURITY_SEEDER_API_TOKEN` 调用库存及添加 API；前端不接触 Token。节点库存不存入本项目数据库，使用 60 秒内存快照，并合并并发读取。添加完成（包括上游错误／超时）使快照失效；旧的在途查询不能覆盖新快照。

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

## REQ-005：永久 RDTS 状态

`backend/src/api/bip110-deployment.ts` 保留原模块路径，内容替换为 `PurityReducedDataApi.getStatus(currentHeight?)`。默认高度来自 `blocks.getCurrentBlockHeight()`；新区块回调直接传入公告高度，避免依赖缓存更新顺序。主网固定 RDTS 激活高度 961637，返回同步状态；未知高度（负数）或其他网络返回 null。无需缓存失效、onNewBlock、版本位阈值或磁盘／数据库访问。

WebsocketHandler 初始快照构建改为同步；新区块在更新 `/api/v1/init-data` 共享快照时生成状态，并向 `want-blocks` 客户端发送相同状态。保留 wire 字段名 `bip110deployment`，前端经 WebsocketService → `StateService.purityReducedData$` → 原组件显示永久规则。旧组件在基线未挂载；本次在主网首页费用／难度卡之后挂载紧凑状态卡。

历史分类仍由 Common 的交易标志检测、Blocks 的摘要／计数更新、原历史分类扫描及前端 Bip110Service／区块徽章处理。组件继续读取 `loadingIndicators['bip110-scan']`；这与已删除的临时部署周期扫描无关。ASERT 配置、版本数据、数据库结构与历史记录保持不变。
