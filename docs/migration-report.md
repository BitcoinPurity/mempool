# REQ-001 迁移分析

首页移除 Ocean／Knots 卡片，添加整行 Purity 地图。新增两条本项目 API、配置及本地地理库读取，不需要数据库迁移或 Seeder 修改。

部署准备：后端设置 `PURITY_SEEDER_API_TOKEN`；`PURITY_SEEDER.API_URL` 默认 `https://seed.bitcoinpurity.org`；代理来源通过 `PURITY_SEEDER.TRUSTED_PROXIES` 明确配置；默认信任 loopback。提供 `MAXMIND.GEOLITE2_CITY` 文件，Docker 部署通过只读卷挂载。API 不要求启用 Lightning 或 ASN 数据库。

反向代理为节点 API 保持 `Cache-Control: no-store`，读取等待时间应大于后端 60 秒验证超时，并覆盖 `X-Real-IP`。前端开发代理也需为此接口延长超时。Token 不写入前端或仓库配置。

目前未经认证的线上 `listnodes` 返回 401，接口依据 Seeder 本地源码与契约；上线前使用安全配置的 Token 做只读契约核对。真实添加会写入远程库存，不用于自动化测试。实现验证与实际部署分别记录。

本地实现已完成：后端节点 API 60 项及配置／Docker 3 项相关测试通过，Cypress 12 项通过，后端编译及英文／多语言生产构建通过，已核对中文产物。完整配置测试存在两项经原始 HEAD 代码复现的既有失败；详见 [TASK-001](tasks/TASK-001.md)。新增入口沿用主网 API，不影响其他网络的首页。Nginx 与本地开发代理覆盖访客 IP 头，节点接口代理等待 70 秒。

## REQ-002：显示开关

新增前端配置 `PURITY_NODES_MAP_ENABLED`，缺省 `true` 保持现有显示行为。普通部署在前端 JSON 配置中设置布尔值后重新生成配置；Docker 前端通过同名环境变量提供 `true/false`，重启容器后读取。关闭时隐藏地图及添加表单并停止组件请求，不影响后端路由，不需要数据库迁移。验证记录见 [TASK-002](tasks/TASK-002.md)。

本地验证完成：Jest 64 项相关测试、Cypress 14 项通过，开发和多语言生产构建通过；确认配置生成器可生成 `true/false` 及 Docker 模板占位符。未部署。
