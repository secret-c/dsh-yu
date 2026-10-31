# 数据库来源适配器

清单包含 id、name、version、adapter、config.path 和可选 enabled。当前支持 sqlite-readonly 与 arknights；未知 adapter 被拒绝，不执行清单脚本。路径安装时，库相对路径以清单目录为基准；直接 JSON 路径以服务工作目录为基准，安装后记录绝对路径。

模型使用稳定框架入口 yu_database_sources 查询安装状态与可用操作/参数 schema，再使用 yu_database_query 的 sourceId、operation、arguments 调用来源。通用入口在 tools.exposure=admin/all 时注册；none 不注册。来源停用后操作清单退出、连接关闭，查询和旧句柄立即拒绝；卸载仅移除组件配置，保留数据库文件。启动时离线来源显示诊断且不阻止主框架管理，其他有效来源仍可查询。

SQLite 以 readOnly 与 query_only 打开，只接受单条 SELECT，最多返回1000行。可 SELECT name,sql FROM sqlite_schema 查看业务表结构。方舟适配器使用自己的连接提供原有 lookup/relics 操作，不共享缓存或发现其他目录。

旧 tools.knowledgeDbPath 仅首次显式迁移为 arknights manifest，保留 tools.arknightsEnabled 的意图；迁移哨兵独立保存，卸载/清空/重启不再恢复。没有明确配置路径时不自动寻找任何库。

扩展其他格式由开发者在 lib/database-sources.js 的 adapters 注册表添加实现。适配器接收清单，验证并返回 {definitions, close}；definitions 含带来源ID的操作名/参数/execute，close 释放全部资源。验证失败需自行释放已打开资源；操作不能依赖全局缓存或重新打开停用来源。批量同步先打开全部候选，全部成功后才替换运行状态，失败保留旧连接和路由。

## 最小安装示例

已有SQLite文件work.sqlite时，将下面清单保存为同目录的work.source.json，在「工具 → 数据库来源」填写该清单在服务端的文件路径并安装。WSL部署应填写Linux路径；安装会验证格式并加载，停用释放连接，卸载保留原文件。

```json
{"id":"work","name":"工作资料","version":"1","adapter":"sqlite-readonly","config":{"path":"./work.sqlite"},"enabled":true}
```

模型先用yu_database_sources取得操作名与参数，再用yu_database_query指定sourceId=work、operation=source_work_query、arguments={"sql":"SELECT name FROM sqlite_schema"}。管理台工具详情也可试运行这两个只读入口。未知数据库格式须实现适配器，不能仅更改清单adapter名称。
