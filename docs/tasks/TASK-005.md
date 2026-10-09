# TASK-005：永久 RDTS 状态替换 BIP-110 部署追踪

需求：REQ-005。基线：fc37e9134。状态：本地实现与相关验证完成；完整套件有已复现的基线失败，部分在线 E2E 依赖未提供；未推送／部署。

## 激活依据与范围

[Purity 规范 §1](https://github.com/saltduck/bitcoinpurity/blob/b711f44afd1dee477674de997f81d544f1f432c6/doc/purity-consensus.md) 明确主网 `nPurityActivationHeight = 961637` 起 RDTS 永久有效、不受投票或到期控制。同 revision 的 `src/consensus/params.h` 定义 `MAINNET_PURITY_ACTIVATION_HEIGHT`；`src/kernel/chainparams.cpp` 赋值主网参数；`src/deploymentstatus.h` 的 `DeploymentActiveAfter` 在此高度直接返回 true。公开固定 revision 文档与本地文档比较一致。本次仅只读核对 Purity，不修改其代码。

主网状态比较当前区块高度（不是下一块），961636 / 961637 / 961638 分别为 not_active / active / active。高于旧 temporary expiry 的高度仍 active。其他网络没有本任务可使用的固定永久激活参数；regtest 测试开关不能由主网参数推断。返回 null 并省略字段；未知内存高度同样省略。ASERT 的 `PURITY.ACTIVATION_HEIGHT`、锚点、难度规则完全不变。

## 实现与热点

原 `getDeploymentInfo` 在每次高度变化遍历当前 retarget 周期，每块串行调用 `$getBlockHash` 与 `$getBlock`；`onNewBlock` 在未锁定的周期末也启动投票扫描。它位于新区块 WebSocket 快照构建路径，最多各 2016 次方法调用，启动显示也会触发。

提供器替换为同步 `getStatus(height?)`，只读取网络配置和已有内存高度并生成六个字段。删除所有投票／阈值／MTP／锁定／到期逻辑及状态缓存，无后台任务。保留模块、组件路径和 wire 字段名；内部类型改为 `PurityReducedDataStatus`，前端 ReplaySubject 改名。完整新契约见 [API 契约](../api-contract.md#req-005bip110deployment-永久状态契约)。

新区块直接传公告高度，既更新初始快照又发送给 blocks 订阅者；初始构建去掉无 I/O 的 async/await。前端状态卡显示永久执行、961637 与无到期，移除旧投票条、倒计时、无用分支和样式。基线组件未挂载，本次接入主网首页并沿用其卡片布局。独立历史违规扫描的订阅／进度条保持。

高度 968113 的周期位置为 433，因此预计每块省去 434 次 getblockhash 和 434 次区块读取。不同高度为各 1–2016 次；区块读取不总是远端 RPC。新路径测试调用数为零，但未执行生产基准；不承诺消除所有慢 RPC 或 watchdog stall。

## 修改文件

共 22 个项目文件；依赖声明、锁文件与配置未改变。

- 后端：`src/api/bip110-deployment.ts`、`src/api/websocket-handler.ts`。
- 前端：`components/bip110-deployment/` 下 TS／HTML／SCSS、`dashboard/dashboard.component.html`、`interfaces/node-api.interface.ts`、`interfaces/websocket.interface.ts`、`services/state.service.ts`、`services/websocket.service.ts`。
- 测试：后端 `bip110-deployment.test.ts`、`websocket-reduced-data.test.ts`、`bip110-classification.test.ts`；前端 `cypress/e2e/mainnet/reduced-data.spec.ts` 与 `cypress/fixtures/mainnet_mempoolInfo.json`（追加新初始状态契约）。
- 文档：需求入口、产品规格、架构、API 契约、迁移报告、任务索引与本文件。

`Common`、`Blocks`、历史分类扫描、数据库／索引、前端 Bip110Service、区块徽章源码没有差异。分类测试实际调用原检测及缓存摘要更新，保留七种违规标志、输出／OP_RETURN 边界、witness／Taproot 规则、历史区块违规计数与权重。前端回归保留历史违规徽章。共识执行状态不重写历史分类。

## 验证

先增加回归测试并观察旧代码失败，再替换实现。状态测试验证激活边界、旧到期之后仍永久有效、重组、ASERT 配置独立、非主网和未知高度；显式断言 getblockhash、区块读取、Electrum 初始化和 SQL 调用为零。WebSocket 测试验证 init-data 共享快照、浏览器 init、新区块字段以及确认／mempool 通知。

- 新增后端三个套件 **34/34** 通过，并以 detectOpenHandles 验证新增测试正常退出。
- 排除配置基线套件的现有后端回归 **16 个套件、273/273** 通过，涵盖 Common 分类、Rust GBT、费用、mempool 同步、Core／Electrum、ASERT／难度及节点 API。完整套件为 17 个套件：16 通过、配置套件失败；277 项通过、2 项失败（共 279 项）。
- 配置测试有 **2 个既有失败、4 个通过**：默认对象缺少测试期望中的 `POOLS_OVERLAY_PATH`，模板期望缺少 `AUDIT_GBT`／`POOLS_OVERLAY_PATH`。在 `/tmp` 以原始 HEAD 的配置、测试、fixture、Docker／前端配置文件保持仓库相对布局复现相同两项；未修复无关配置。
- Cypress 三个套件共 **28/28** 通过：新增永久状态／历史徽章 **5/5**、现有 recent-transactions **5/5**、首页节点地图 **18/18**。共享主网初始 fixture 增加符合其历史高度的永久规则状态，避免 mock 客户端缺少新字段。
- 现有 `mainnet.spec.ts` 包含依赖 HTTP API／真实 socket 的测试，本机 8999 后端未启动，代理 ECONNREFUSED，未能完成有效验收；已在获得重复失败后终止此在线套件，未声称通过。使用模拟 socket 与本地 fixture 的状态／徽章／交易回归不依赖该服务。
- 后端 `npm run build`、`tsc --noEmit -p tsconfig.json`、前端 `tsc --noEmit -p tsconfig.app.json`、Angular 开发构建和 **多语言 production 构建及 sync-assets** 通过；前端沿用已有组件样式预算警告。
- 修改的前后端源码 ESLint **0 errors**，沿用现有警告；后端测试路径按项目 ESLint 默认忽略，测试由 TypeScript／Jest 校验。
- `git diff --check` 通过，核对分类、区块／徽章、数据库、ASERT、Rust 源码和依赖锁文件无差异。

本地验证依赖准备：前端使用未改动锁文件 `npm ci --ignore-scripts --include=optional`；Cypress 测试运行器单独装在 `/tmp`，未更改依赖声明／锁文件。后端复用安装依赖与本项目既有 macOS Rust GBT 二进制，并逐文件核对其 Rust 源码／Cargo.lock 与本 checkout 一致；没有修改依赖项目源代码。

本机 Jest 默认文件发现一直未结束，本次使用等价配置并启用 `haste.forceNodeFilesystemAPI=true`、禁用 watchman。全套旧测试原有 BackendInfo 定时器会阻止自然退出，因此完整回归使用 forceExit；新增分类测试显式 mock BackendInfo，不留下定时器。这些测试运行设置未改动仓库 Jest 配置。

完整回归的两项失败与原始 HEAD 复现一致；相关验证完成。生产性能与依赖在线后端的完整 E2E 验收尚未执行。

## 手动部署与回滚

以下仅为操作说明，本任务未执行任何生产操作。前后端载荷变更应配套发布；不得只发布后端而让旧前端继续解读投票字段。

1. 在批准发布前核对 VPS 的实际 revision、服务名、工作目录、后端端口、前端静态根目录及现有配置。保存旧发行目录／哈希、前端静态产物和配置；保持 RPC／Electrum 端点、认证、缓存路径、数据库、Redis 和 ASERT 设置。不要输出凭证。
2. 在 Ubuntu 独立 staging 准备审阅后的源代码，使用现有锁文件与 Node／Rust 工具链构建；不要复制本次 macOS node_modules 或原生二进制。后端执行 `npm ci` 和 `npm run build`，前端执行 `npm ci` 和 `npm run build`；用实际部署前端配置生成产物。执行下面聚焦测试与现有相关回归，已知基线失败需独立确认。

   ```sh
   cd "$stage/backend"
   ./node_modules/.bin/jest --runInBand --coverage=false src/__tests__/api/bip110-deployment.test.ts src/__tests__/api/websocket-reduced-data.test.ts src/__tests__/api/bip110-classification.test.ts
   ```

3. 在获准维护窗口正常停止后端并保留旧完整 dist；按现有发行流程切换新后端 dist 与前端静态产物，再正常启动后端。仅代码发布，不删除缓存／历史 BIP-110 数据、不执行 reindex／数据库迁移、不修改 Core、Electrum 或 MariaDB 服务。客户端需刷新或重连以使用配套前端。
4. 核对本机、反向代理及公网 `/api/v1/init-data` 的 `bip110deployment` 六字段；主网已超过 961637 时应 active、permanent=true、expiryHeight=null。确认前端永久状态、激活高度、无到期，以及新区块的区块公告、费用、mempool 和难度更新。已有违规历史块应保留徽章和摘要，历史分类进度可继续出现。
5. 以相同网络、节点、缓存／链状态观察多个新区块的 updateBlocks 阶段耗时与 RPC 数量，分别记录状态计算零 I/O 与整体区块流程耗时；不能用模拟测试代替生产基准。
6. 回滚时正常停止后端，恢复成对的旧后端 dist 与旧前端静态版本、正常启动并重新加载页面。保留运行期间写入的缓存／历史分类结果；无需数据库、Core 或缓存回滚。旧版本将恢复原投票扫描开销。
