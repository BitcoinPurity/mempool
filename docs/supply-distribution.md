# Supply Distribution 部署

功能默认关闭。数据来自本机 Purity 节点：开启后自动做一次 `dumptxoutset` 引导，之后逐块更新，数据高度固定为 tip − `CONFIRMATIONS`（默认 6）。

## 1. 创建供应库

沿用现有 MariaDB，新建独立 database（主网与 Signet 各一个）：

```sql
CREATE DATABASE mempool_supply;
GRANT ALL ON mempool_supply.* TO 'mempool'@'localhost';
-- Signet
CREATE DATABASE mempool_signet_supply;
GRANT ALL ON mempool_signet_supply.* TO 'mempool'@'localhost';
```

表结构由后端启动时自动创建。主网常驻约 8–10GB（约 6000 万行，估算）。

## 2. 快照共享目录

节点和后端在同一台机器上，使用同一个绝对路径。节点默认 umask 077，所以用默认 ACL 让后端用户能读取和删除快照：

```sh
sudo mkdir -p /var/lib/purity-supply
sudo chown bitcoin:bitcoin /var/lib/purity-supply
sudo setfacl -m u:mempool:rwx /var/lib/purity-supply
sudo setfacl -d -m u:mempool:rw /var/lib/purity-supply
```

磁盘峰值约 15GB（主网快照约 9GB，加上 `TEMP_DIR` 下约 6GB 分区文件；估算），引导结束后自动删除。

## 3. 节点

建议开启 `coinstatsindex=1`，后端会用它逐块核对 UTXO 数和总额；未开启时跳过校验。撤销重组需要节点保留过时区块的 undo 数据（未修剪的节点满足）。

## 4. 配置

后端 `mempool-config.json`：

```json
"SUPPLY_DISTRIBUTION": {
  "ENABLED": true,
  "DATABASE": "mempool_supply",
  "CONFIRMATIONS": 6,
  "TOP_N": 10000,
  "SNAPSHOT_DIR": "/var/lib/purity-supply",
  "TEMP_DIR": "",
  "DUMP_TIMEOUT": 10800000
}
```

Signet 进程的 `DATABASE` 默认是 `mempool_signet_supply`，不能使用主网库名。前端 `mempool-frontend-config.json` 设置 `"SUPPLY_DISTRIBUTION_ENABLED": true`（Docker：环境变量同名）。

## 5. 开启时机

`dumptxoutset` 运行期间节点可能锁定数分钟，出块处理、后端 RPC 和 Electrum 同步会暂停，后端会自动重试。请在低峰时段重启后端以开启功能，并先在 Signet 上测量锁定时长。日志中 `Supply bootstrap:` 显示各阶段进度；快照满 6 个确认后状态变为 ready。

## 6. stale 后恢复

无法撤销重组或 coinstatsindex 校验不一致时，日志出现 `Supply distribution marked stale`，页面保留最后数据并提示暂停。在低峰时段执行：

```sql
DELETE FROM mempool_supply.supply_state;
```

然后重启后端，会重新引导。
