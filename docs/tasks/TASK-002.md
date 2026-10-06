# TASK-002：地图显示开关

状态：本地实现及验证完成，未部署。需求：REQ-002。

1. 先补充默认开启、显式开启／关闭及关闭后无节点请求的 Cypress 测试，以及配置和 Docker 默认值测试。
2. 添加 `PURITY_NODES_MAP_ENABLED` 类型、默认值、样例和首页条件，接入 Docker 运行时配置。
3. 更新使用说明，运行相关测试、前端编译、脚本语法和差异检查。

## 验证记录（2026-10-05）

- 先复现配置测试中开关缺失、Cypress 中关闭后地图仍显示的失败，再实现开关。
- 节点与配置相关 Jest 64 项通过；两项此前已记录的配置期望失败在本次聚焦运行中跳过。
- Cypress 14 项通过，包含缺省开启、显式开启、显式关闭后两分钟无节点请求，以及原地图和添加流程回归。
- 开发构建和多语言生产构建通过；`generate-config.js` 在临时目录分别生成了真实布尔值 `true/false` 和对应 Docker 模板占位符。
- 相关 ESLint 检查无错误（原 StateService 有既有警告）；Docker 入口脚本语法和差异检查通过。

配置使用方法见 [frontend README](../../frontend/README.md#purity-node-map-visibility) 和 [Docker README](../../docker/README.md#purity-node-map-configuration)。后端代码及接口不变，无数据库迁移，未部署。
