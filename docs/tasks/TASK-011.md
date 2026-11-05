# TASK-011：Supply Distribution

需求：REQ-011。状态：本地实现与验证完成，未提交／部署；尚未在真实 Purity 节点上引导。

- 后端：`SUPPLY_DISTRIBUTION` 配置与校验；`DB({ database })` 与 `$withTransaction`；独立供应库 schema；Core v2 UTXO 快照解析、两遍分区聚合 worker；逐块跟随（tip − 6）、超过 6 块重组的撤销、coinstatsindex 校验与 stale；三个只读 API。
- 前端：`/supply` 页面（概览、持有集中度环形图、区间图表／表格、Top Addresses 分页、新区块后自动刷新）、导航图标、地址页排名行，`SUPPLY_DISTRIBUTION_NETWORKS` 按网络开启，默认为空。
- 文档：产品规格、架构、API 契约、部署说明 [supply-distribution.md](../supply-distribution.md)。

## 验证（2026-11-04）

- 后端 Jest 29 个套件 462/462 通过（新增 45 项：快照编码向量、6 种脚本压缩、截断与计数错误、地址往返与 BIP173/350 向量、区间边界、发行量、"引导+区块 = 区块后引导"、撤销对称、8 块重组撤销后与新分支重新引导一致、stale 条件、引导限频、路由分页与排名门槛、配置校验）。TypeScript 编译通过；新文件 ESLint 0 错误。
- 集成测试（仓库 `docker-compose.test.yml`，MariaDB 10.5.21）4/4：真实 SQL 引导 3 万币、索引构建、块应用与撤销后表内容逐行一致、冲突与不一致回滚、排名查询、再次引导换表。
- 编译后的 worker 线程在真实线程中加载并正确上报错误。
- 前端生产构建通过（仅既有样式预算警告）；Cypress（模拟 API，沙箱外运行）8/8：页面渲染、分页、新区块后重新拉取、无数据、stale、开关关闭、地址页排名显示／隐藏。桌面与 375px 截图检查布局。

## 追加（2026-11-04）

- 前端开关改为按网络：`SUPPLY_DISTRIBUTION_NETWORKS`（逗号分隔），路由守卫、导航和地址页排名只在所列网络生效。
- 持有集中度：`/supply/distribution` 新增 `tiers`，前端环形图。后端单测（分层边界、TOP_N 截断、零余额、按高度缓存）与集成测试（MariaDB 中各层之和等于总额）通过；Cypress 9/9。
- 多语言：36 条 `supply.*` 文字翻译到构建的全部 33 种语言；生产多语言构建无 `supply.*` 缺失翻译警告。译文为本次编写，未经母语者审校。

## 未验证

- 未在真实节点上运行 `dumptxoutset`：主网耗时、节点锁定时长、worker 峰值内存、临时磁盘与供应库大小未知。按部署说明先在 Purity Signet 上实测并核对 `gettxoutsetinfo`。
- Signet 地址前缀假定与 Bitcoin testnet 相同（`tb`），需在 Signet 上与节点 `decodescript` 对照确认。
