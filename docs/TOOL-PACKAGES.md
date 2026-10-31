# 可装卸工具包

工具页的「可装卸工具包」可安装命名实例、停用、重新加载、卸载并实际调用。现有类型：`tomimi`（完整肉鸽敌人面板计算，保留 search/scenario/calculate）、`calculator`（结构化四则运算，无表达式执行）、`documents`（自有文档检索/阅读）。同一类型可安装多个不同 ID；documents 实例共享自有文档及文档库权限，不复制资料。

例如工具页填写或保存服务器 JSON 清单后按路径安装：

```json
{"id":"work_math","name":"工作计算器","version":"1","adapter":"calculator","config":{},"enabled":true}
```

Tomimi 的 config 可为 `{"path":"/home/yu/my-tomimi-data"}`，需要真实 Tomimi 数据；空路径使用本机默认查找目录。路径安装时相对路径按清单所在目录解析；直接 JSON 的非空路径按服务器工作目录解析。calculator/documents 的 config 只能为 `{}`。不接受凭据或额外配置字段，因此清单无可导出的令牌字段；不会下载、安装或执行任意插件脚本。

模型先调用 `yu_tool_packages` 获取实例和操作 schema，再调用：

```json
{"packageId":"work_math","operation":"package_work_math_calculate","arguments":{"operator":"multiply","a":6,"b":7}}
```

`yu_tool_call` 是稳定框架分发入口。启停、卸载立即更新路由，旧句柄失效，Tomimi 在途子进程被取消；安装其他实例不会打断未变更实例。卸载移除清单、保留数据文件/文档。重启不恢复已卸载实例，清空配置后不会重建。首次升级按原有效开关迁移 documents/tomimi（包括停用状态），之后以清单为准。旧 JSON 开关导入转换为对应迁移实例；新导出仅保存清单。未知 adapter/无效配置及加载失败拒绝安装，保留其他实例。

`tools.exposure=none` 关闭全部 Yu 模型入口；admin/all 都能使用通用实例入口。切换 exposure 仍需重启。工具页管理 API 不受模型暴露级别影响。任务工具策略针对 `yu_tool_call` 整个入口，不提供单实例权限隔离；需要不同实例隔离授权时应先增加相应策略。

数据库来源在同页分区管理，保留专用数据库 adapter 和稳定 `yu_database_sources` / `yu_database_query`。`yu_admin` 为核心管理入口（含记忆/文档写入等管理操作），并非可选检索包；DSH 提供的宿主工具由 DSH 自己管理，本页不能卸载宿主插件。

## 扩展本地工具

扩展点是 `lib/tool-packages.js` 中 `adapters` factory 注册表：维护者在代码里导入可信本地实现，新增 `type: manifest => ({definitions, close})`。`definitions` 每项提供 `name, description, parameters, output, execute`，与现有 calculator/documents/Tomimi 相同；`close()` 必须同步撤销资源并取消在途任务。同步扩展 `validateManifest` 的该类型 config 校验（仅白名单字段；如新增凭据必须同时实现 API/导出遮蔽，不能直接照搬当前返回整个 config 的方式）。注册后工具页类型列表自动包含它，不需改 UI 或逐一注册模型工具。

新增 adapter 的调用始终经过实例 ID 和生命周期检查，操作名自动加 `package_<id>_` 前缀。开发者应添加失败安装不影响既有实例、卸载后旧句柄失效、重启不复活测试。这里支持源码接入 adapter，不声称任意第三方插件格式直接兼容。
