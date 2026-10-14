# TASK-005：RPC 完整响应超时与中断处理

状态：本地实现与验证完成，未部署。需求：REQ-005。

- 在本地真实 HTTP 服务中先复现持续分块但不结束、响应体中途断开两种挂起。
- 保留总计时器到响应完整结束，响应错误／中断及时拒绝，清理计时器及失败连接。
- 保持现有超时配置与默认值、socket 空闲超时、认证、RPC 结果、并发及连接策略；不部署、不重启 VPS。

## 验证记录（2026-10-14）

测试文件：`backend/src/__tests__/rpc-api/jsonrpc.test.ts`。修复前两个新增回归均失败：配置总超时 150ms、每 20ms 发送数据的响应直到 1000ms 观察期限仍 pending；总超时 1000ms 的响应在 20ms 后断开，直到 500ms 观察期限仍 pending。

修复后两个回归通过。持续分块场景在配置总期限拒绝为 `ETIMEDOUT` 并关闭连接；中断场景及时拒绝为 `ECONNRESET`，后续请求可正常成功。补充正常分块响应、单笔／批次结果、RPC 错误、无效 JSON、响应前超时及完整响应后计时器清理，RPC 套件共 7 项通过。

```sh
cd backend
./node_modules/.bin/jest --runInBand --coverage=false src/__tests__/rpc-api/jsonrpc.test.ts src/__tests__/api/bitcoin-api-sync.test.ts src/__tests__/api/transaction-utils-sync.test.ts src/__tests__/api/mempool-sync.test.ts
npm run tsc
./node_modules/.bin/eslint src/rpc-api/jsonrpc.ts
```

相关 Jest：4 个套件、41 项通过；后端 TypeScript 编译通过；改动源文件 ESLint 为 0 个错误、17 个警告，与原始 HEAD 一致。`git diff --check` 通过。测试只访问本机临时 HTTP 服务，不涉及 VPS。线上具体触发方式及部署后行为未验证。
