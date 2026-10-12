# TASK-001：Purity 节点世界地图与节点提交

状态：本地实现及验证完成，未部署。需求：REQ-001。

1. 先补充后端 Jest 和前端 Cypress 回归测试。
2. 实现认证代理、IP 定位、快照缓存、输入验证、可信代理来源限流与并发限制。
3. 替换首页两张卡片，实现整行地图、统计、详情及添加表单。
4. 同步配置、开发／生产代理及国际化文案。
5. 完成相关测试、前后端编译和差异检查；记录部署前置条件。

## 验证记录（2026-10-05）

- 测试先行：初始后端测试因缺失实现失败；随后补充 IPv6 嵌入 IPv4 地址及代理头回归，先复现失败再修正。
- 后端：`npm run build` 通过；节点 API Jest 60 项通过，Seeder 默认配置和 Docker 模板／启动脚本测试 3 项通过。
- 前端：英文生产构建和 34 个语言目录的本地化生产构建通过，并核对了中文产物中的地图、分类和超时文案；Cypress 节点地图 12 项通过（桌面 1280px、手机 390px），覆盖实际 SVG 点位、点击详情、分类切换、60 秒刷新、IPv6、输入校验、验证结果、重复提交、刷新、超时和加载重试。
- 浏览器测试使用开发配置构建和模拟节点 API；现有 `DataCyDirective` 会从生产构建移除测试选择器。缺少的可选 Cypress 工具仅在临时目录安装，未修改依赖清单。
- 新增实现和 Cypress 文件的 ESLint 检查通过；`sh -n docker/backend/start.sh`、开发代理 JavaScript 语法检查、`git diff --check` 通过。

## 现有失败与上线条件

完整配置测试的 `should return defaults when no file is present` 和 `should override the default values with the passed values` 两项失败，涉及原有 `POOLS_OVERLAY_PATH`／`AUDIT_GBT` 期望缺失。使用 HEAD 的原始配置、测试和模板在临时目录复现了同样的两项失败；本任务不修改这些无关期望。生产构建另有原有组件样式预算警告。新增文案已提供英文和中文，其他语言回退英文，并产生缺少翻译的构建警告。

上线仍需有效 `PURITY_SEEDER_API_TOKEN`、可读 GeoLite2-City 文件及实际代理 CIDR；使用认证的只读库存请求核对线上契约。未执行真实节点添加、部署、提交或推送；无数据库迁移。

## 节点 API 域名更新（2026-10-12）

- 默认上游地址改为 `https://seeder.bitcoinpurity.org`，同步后端配置、Docker 默认值、样例、测试夹具及文档；其余配置、接口路径和行为不变。
- 先更新测试预期，确认旧域名导致 5 项失败；修改后节点 API 74 项及 Seeder／Docker 配置 3 项相关测试通过。
- 后端 TypeScript 检查、Docker 启动脚本语法、样例和夹具 JSON 检查、`git diff --check` 通过；项目中已无旧 API 域名引用，前端及节点 API 实现无差异。
- 仅使用模拟上游请求验证，未调用真实添加接口，未推送、未部署。
