# 架构

## Purity 节点地图

首页地图组件通过现有 ApiService 请求本项目后端。后端通过固定配置的 Seeder 地址和环境变量 `PURITY_SEEDER_API_TOKEN` 调用库存及添加 API；前端不接触 Token。节点库存不存入本项目数据库，使用 60 秒内存快照，并合并并发读取。添加完成（包括上游错误／超时）使快照失效；旧的在途查询不能覆盖新快照。

位置由 `MAXMIND.GEOLITE2_CITY` 指定的本地文件提供，仅需 City 数据库，不依赖 Lightning、ASN 或数据库索引功能。文件读取器延迟打开并复用；缺失文件给出明确服务错误。某 IP 无位置时返回 `location: null`。

公开写接口仅接受公网 IP 和合法整数端口。来源默认为 TCP 远端地址；来自 `PURITY_SEEDER.TRUSTED_PROXIES` 中地址的请求才使用 Nginx 覆盖的 `X-Real-IP`。本地 Unix socket 也可接受该代理头。来源每分钟一次、每进程两个并发请求，响应 429 表示受限。

界面每分钟查询一次，销毁时停止计时和请求。ECharts 两个散点系列在本地世界底图显示节点；原始客户端字符串作为文本呈现，不插入 HTML。分类保留 `0` 与 `null` 的差别，不从入站证据推断端口公开性。

`StateService.env.PURITY_NODES_MAP_ENABLED` 默认 `true`。首页模板同时检查主网和该开关；关闭时不实例化地图组件，因此不会打开节点刷新订阅。开关沿用 `mempool-frontend-config.json` → `window.__env` 的配置流程；Docker 入口脚本提供同名环境变量默认值并导出模板占位符。后端无需增加开关。
