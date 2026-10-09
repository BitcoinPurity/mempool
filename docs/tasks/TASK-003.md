# TASK-003：后端冷启动同步诊断与修复

状态：本地实现及验证完成，未提交、未推送、未部署。需求：REQ-003。检查基线：`f77b6784e`。验证日期：2026-10-10（Australia/Melbourne）。

## 原因与证据

- **已确认**：`$appendMempoolFeeData()` 检查空缓存后直接 await 全量元数据，没有在途 Promise。修复前 8 个并发调用触发 8 次 `getrawmempool(true)`；修复后 Core 和继承该类的 Electrum 路径均只发起一次。
- **已确认**：交易抓取的 allSettled 过滤了失败结果，原日志不能区分超时／交易消失；并发 8 不变，新增汇总不改变返回顺序、失败过滤或重试策略。
- **已确认**：`$updateMempool()` 仅在正常末尾清理 watchdog；抓取、候选集、回调或 Redis 抛错后留下计时器。现在最外层 finally 清理且保留原异常。真实 pending 仍在 120 秒告警，阶段在异步调用前更新。
- **已确认**：初始 `diff = core - cached` 只是净数量差，在给定快照中为 228，实际缺失为 229、过期为 1。现日志按 ID 集合报告真实数量；清空保护、删除、回调顺序保持不变。
- **待线上验证**：重复 verbose RPC 是否是本次超过 120 秒的主要原因；是否还有 RPC 超时、慢响应体、回调、Redis 或主循环其他阶段的延迟。不能由模拟测试宣称真实 VPS 停顿已经消失。

磁盘恢复后的第一个缺失交易仍会按原行为获取全量手续费元数据；本次将并发重复查询合并，不移除该快照。入口的非 verbose getrawmempool、区块更新不在 `$updateMempool()` watchdog 内。原“Loaded mempool from disk cache”耗时不包含随后 `$setMempool()` 和 RBF 恢复。

## 改动与差异

| 文件 | 改动 |
| --- | --- |
| `backend/src/api/bitcoin/bitcoin-api.ts` | 每实例共享在途初始化链、失败后清理、元数据计时、原始 getrawtransaction 慢请求警告 |
| `backend/src/api/transaction-utils.ts` | 并发 8 的完整抓取计时、成功／失败／慢请求／超时分类和最大耗时，保留 allSettled 过滤 |
| `backend/src/api/mempool.ts` | 真正增量数量、批次开始／结果／中止日志、阶段耗时和 watchdog finally 清理 |
| 三个 `backend/src/__tests__/api/*-sync.test.ts` | 34 项聚焦回归测试 |
| 需求入口、规格、架构、契约、迁移报告、任务索引 | REQ-003 的范围、证据与操作说明 |

可在项目根目录查看实现差异：

```sh
git diff -- backend/src/api/bitcoin/bitcoin-api.ts backend/src/api/transaction-utils.ts backend/src/api/mempool.ts
git diff -w -- backend/src/api/mempool.ts
```

第二条便于排除 try/finally 对现有方法主体造成的缩进差异。新增测试文件仍未跟踪，可直接阅读；交付的完整补丁包含实现、测试和文档。

## 验证记录

- 测试先行：先复现并发初始化 8 次而非 1 次、抓取诊断缺失和异常退出后的残留 watchdog；再实现修复。
- 新增 34 项：Core／Electrum 单次初始化、独立实例、共享失败及重试、手续费命中／回退、确认交易、慢 RPC 成功／失败；并发 8、失败过滤与顺序、两类超时、RPC -5、完整抓取慢操作、Esplora 与 forceCore；真实 BitcoinApi＋TransactionUtils＋Mempool 组合冷启动、恢复缓存及 RBF／spend map、过期／已挖出交易删除、清空保护、稳定周期时间预算、Redis 开关、回调、watchdog 失败清理与真实 pending。
- 聚焦及已有相关测试：10 个套件、215 项通过。聚焦测试自行退出，无需 forceExit，计时器测试断言退出后只剩周期统计计时器。
- `npm run tsc` 通过。三个改动源文件 ESLint：0 errors、45 warnings；在原始 HEAD 快照执行同样 lint 也是 45 条。
- 完整套件：复用本机已有的 Rust GBT 二进制后，13 个套件通过、1 个失败；229 项通过、2 项失败。原始 HEAD 同条件为 195 项通过、同样 2 项配置测试失败（期望缺少 POOLS_OVERLAY_PATH／AUDIT_GBT）。这两项未在本任务改动或屏蔽。
- 默认本地依赖目录缺少可加载的 GBT 原生包，最初 common、fee-api、gbt 套件无法加载。后来从已有 `rust/gbt/gbt.darwin-arm64.node` 复制到临时目录，使用 Jest moduleNameMapper 加载真实二进制，未修改依赖项目或仓库测试配置。手续费推荐、RBF 检测和 GBT 模板回归均通过。
- 完整套件有现存未释放句柄，本次及原始 HEAD 都使用 forceExit 收尾；新增聚焦测试不用此选项。未执行依赖真实数据库的 integration suite，未连接生产节点，未做真实 Ubuntu 冷启动基准。
- `git diff --check` 通过。实现不改 JsonRPC、认证、超时、并发、数据库、公开 API、磁盘缓存格式或前端。

复现相关测试：

```sh
cd backend
npm run tsc
./node_modules/.bin/jest --runInBand --coverage=false src/__tests__/api src/__tests__/cluster-mempool --testRegex='.*\.test\.ts$'
./node_modules/.bin/eslint src/api/bitcoin/bitcoin-api.ts src/api/transaction-utils.ts src/api/mempool.ts
```

在本次 macOS 测试环境，完整套件的额外参数为：

```sh
./node_modules/.bin/jest --runInBand --coverage=false --forceExit \
  --moduleNameMapper='{"^rust-gbt$":"/tmp/mempool-sync-native-gbt/index.js"}'
```

此临时目录仅用于本地验证，不作为 Ubuntu 发布产物。在具备本机原生 GBT 包的正常构建环境无需 moduleNameMapper。

## 日志说明与示例

固定诊断阈值为 **5000 ms（包含等于）**，定义在三个改动源文件的常量中，不新增配置键，不是请求取消期限。初始同步的快批次用 info，稳定周期用 debug，慢操作／失败用 warn。`MEMPOOL.STDOUT_LOG_MIN_PRIORITY` 至少允许 info 才能看到启动进度；需要详细阶段时间时使用 debug。设置日志级别仍沿用既有服务配置流程。

下面只是格式示例，时间不是实测或承诺：

```text
[MEMPOOL_SYNC] mode=incremental inSync=false core=32353 cached=32125 missing=229 stale=1
[MEMPOOL_SYNC] batch=1/1 requested=229 started
[MEMPOOL_SYNC] initializing verbose mempool metadata started
[MEMPOOL_SYNC] verbose mempool metadata transactions=32353 duration=13812ms threshold=5000ms slow=true
[MEMPOOL_FETCH] requested=229 fetched=229 failed=0 slow=8 max_fetch=13900ms duration=17000ms threshold=5000ms ETIMEDOUT=0 ESOCKETTIMEDOUT=0 rpc_-5=0 other_errors=0
[MEMPOOL_SYNC] batch=1/1 fetched=229 failed=0 duration=17000ms threshold=5000ms slow=true
[MEMPOOL_SYNC] stage="fetching transaction batch 1/1" duration=17000ms elapsed=17002ms next="processing fetched transactions"
The mempool is now in sync!
[MEMPOOL_SYNC] completed inSync=true remaining=0 duration=17020ms
```

原始 RPC 慢请求另有 `[MEMPOOL_RPC] getrawtransaction duration=6000ms threshold=5000ms slow=true`。它不包含手续费转换等待；`MEMPOOL_FETCH.max_fetch` 和 slow 统计包含该等待、不包含排队；整批 duration 包含排队。因此慢完整抓取不等于原始 RPC 慢。错误只输出分类和计数，不输出凭证、端点错误对象、交易内容或逐笔 ID。

若调用真正超过 120 秒，会报告例如：

```text
$updateMempool stalled at "fetching transaction batch 1/1" duration=120000ms
```

阶段日志可继续指出候选集、异步回调、Redis 添加／flush／删除／RBF 等耗时。结束异常会清理 watchdog，原错误仍传回主循环；被过滤的失败交易在下一轮仍缺失时继续抓取。

## Ubuntu 手动部署与回滚

以下是供操作者在批准发布后执行的 **systemd 示例**；每步失败即停止，排除失败后再继续；实际服务名、工作目录、配置文件与发布路径必须来自现有部署。若使用 PM2 或容器，应沿用该部署的发布／回滚方法。没有在本任务执行这些命令。

1. 确认服务的实际工作目录及现有配置路径，不输出 Environment 或凭证。记录旧版本／构建文件哈希。已有进程不受临时 shell 导出变量影响。

   ```sh
   svc='<实际 systemd unit>'
   sudo systemctl show "$svc" -p WorkingDirectory -p FragmentPath
   live='/实际/运行/backend'
   stage='/实际/独立构建/mempool'
   cfg='/实际/使用/mempool-config.json'
   sha256sum "$live/dist/api/bitcoin/bitcoin-api.js" "$live/dist/api/transaction-utils.js" "$live/dist/api/mempool.js"
   ```

   检查实际配置，只输出白名单字段（不输出用户名、密码、Cookie、Token）：

   ```sh
   python3 - "$cfg" <<'PY'
   import json, sys
   c = json.load(open(sys.argv[1]))
   for section, keys in {
       'MEMPOOL': ['BACKEND', 'CACHE_ENABLED', 'CACHE_DIR', 'HTTP_PORT', 'STDOUT_LOG_MIN_PRIORITY'],
       'REDIS': ['ENABLED'], 'CORE_RPC': ['HOST', 'PORT', 'TIMEOUT'],
       'ELECTRUM': ['HOST', 'PORT', 'TLS_ENABLED']
   }.items():
       print(section, {k: c.get(section, {}).get(k) for k in keys})
   PY
   ```

   文件中未写的值沿用 `src/config.ts` 默认值；另核对服务已配置的覆盖项。保持实际 CACHE_DIR、工作目录、Redis 设置、2048 MB 启动上限和 RPC 60000 ms 超时。

2. 在独立 staging 中准备审阅过的修复源码：核对基线 f77b6784e 与当前实际生产版本；生产版本存在其他改动时先移植并审阅，不能直接覆盖未知版本。将交付补丁传入 staging，先 git apply --check 再 git apply。按现有 Ubuntu 工具链安装锁定依赖并构建，不在 live 目录构建：

   ```sh
   cd "$stage/backend"
   npm ci
   npm run build
   ./node_modules/.bin/jest --runInBand --coverage=false src/__tests__/api/bitcoin-api-sync.test.ts src/__tests__/api/transaction-utils-sync.test.ts src/__tests__/api/mempool-sync.test.ts
   ```

   此项目 preinstall 会编译本项目 Rust GBT，需要现有构建文档要求的 Rust／Node 工具链。使用 Ubuntu 生成的依赖与产物，不复制本次 macOS 验证用的符号链接或原生二进制。依赖锁文件未改变。

3. 维护窗口中正常停止后端，等待退出；保留完整旧 dist 和配置，保留所有磁盘／RBF／Redis 缓存。仅替换本任务对应的三个编译文件，避免修改配置或目录解析：

   ```sh
   sudo systemctl stop "$svc"
   backup="${live}/dist-before-sync-$(date -u +%Y%m%dT%H%M%SZ)"
   sudo mkdir "$backup"
   sudo cp -a "$live/dist/." "$backup/"
   sudo cp -a "$stage/backend/dist/api/bitcoin/bitcoin-api.js" "$live/dist/api/bitcoin/bitcoin-api.js"
   sudo cp -a "$stage/backend/dist/api/transaction-utils.js" "$live/dist/api/transaction-utils.js"
   sudo cp -a "$stage/backend/dist/api/mempool.js" "$live/dist/api/mempool.js"
   sha256sum "$stage/backend/dist/api/bitcoin/bitcoin-api.js" "$live/dist/api/bitcoin/bitcoin-api.js"
   sha256sum "$stage/backend/dist/api/transaction-utils.js" "$live/dist/api/transaction-utils.js"
   sha256sum "$stage/backend/dist/api/mempool.js" "$live/dist/api/mempool.js"
   sudo systemctl start "$svc"
   ```

   检查文件所有者／权限符合现有服务读权限；保存 backup 路径和新旧哈希到运维记录。三文件替换不会更新旧 fetch-version 元数据，因此应以交付哈希及重启后的新日志核验本次运行代码；使用既有完整发行流程时也可发布完整构建并保留旧发行目录。

4. 验证运行状态、新诊断数量、唯一元数据初始化、零失败或后续恢复，以及同步成功后的本机和公网费用接口。先记录耗时再判断改善；单次 HTTP 200 不证明持续稳定。

   ```sh
   sudo systemctl is-active "$svc"
   sudo journalctl -u "$svc" --since '10 minutes ago' --no-pager \
     | rg 'MEMPOOL_SYNC|MEMPOOL_FETCH|MEMPOOL_RPC|The mempool is now in sync|updateMempool stalled'
   curl --max-time 10 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8999/api/v1/fees/recommended
   ```

   实际端口／API 前缀按服务配置调整。确认同一初始周期中元数据 started 仅出现一次；失败后稍后重试可以再次出现。继续观察多个周期的失败数、超时分类、slow/max_fetch 和阶段耗时。若可控地测试冷启动，沿用当前有效缓存正常重启，绝不删除或重置缓存。

5. 若回归或仍未同步，先保留上述诊断。回滚时正常停止后端，把三个旧文件还原，再启动并检查旧服务状态：

   ```sh
   sudo systemctl stop "$svc"
   sudo cp -a "$backup/api/bitcoin/bitcoin-api.js" "$live/dist/api/bitcoin/bitcoin-api.js"
   sudo cp -a "$backup/api/transaction-utils.js" "$live/dist/api/transaction-utils.js"
   sudo cp -a "$backup/api/mempool.js" "$live/dist/api/mempool.js"
   sudo systemctl start "$svc"
   sudo systemctl is-active "$svc"
   ```

   无数据库／缓存格式迁移，不恢复或删除运行期间产生的缓存。正常退出可能保存缓存，这是原有行为。

## 后续优化优先级

1. **先取证**：在同样节点、缓存和链状态下记录新日志。定位原始 RPC、元数据初始化、完整抓取、回调、Redis 或方法外主循环阶段。当前仍可能有真实超时导致多轮并发波次耗时，不能靠延长 watchdog 解决。
2. **单独验证传输失败**：JsonRPC 在收到响应头后清除总计时器，socket 超时只约束空闲；没有显式响应体 error／aborted 处理。为截断响应、持续分块、响应头后停顿编写传输测试，证明确实相关后才改变超时／异常语义。
3. **再测连接复用**：`agent: false` 无跨请求 keep-alive。对远程 RPC 的有限连接池可能节省 TCP 建连，但现有 8 笔并行 103 ms 的测量不能证明这是主要瓶颈。优化应单独测试认证、序列化、超时及连接上限，保持并发 8 后对比真实 Ubuntu 延迟。
4. **仅证据支持时调整策略**：全量手续费快照的固定成本或 RPC 并发策略需独立评估。本次不增加并发、不取消快照、不改变缓存寿命或手续费规则。
