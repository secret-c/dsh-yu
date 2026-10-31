# 安装与版本位置

这是准备发布到 GitHub 的源码快照。要求 Node.js 22 或更新版本，以及 DeepSeek Harness 0.2.1-rc.5 公共会话接口。包名为 @yu/companion，版本为 1.0.0；冻结版本以 Git tag 和包 SHA-256 区分。

## 从源码隔离试用

先安装并使 dsh 命令可用，在仓库目录执行 node scripts/start-isolated.mjs。脚本创建独立的 yu-isolated 宿主与数据目录，不复制现用账号、模型密钥或旧配置。可用 YU_REPRO_ROOT 指定全新的试用根目录。管理台默认为 http://127.0.0.1:58810/ 。

## 安装发布包

发布包已含前端构建，无需安装开发依赖。将压缩包解到长期保留的目录，在 DSH 包安装入口安装该目录中的 @yu/companion bundle。保留 bundle 的 cordis.patch.yml：它声明 yu-companion 和 yu-group 预设。不要将文件解到已有数据目录。

宿主 profile 中的 @yu/companion 依赖或目录链接决定实际载入的安装位置；源码仓库、压缩包与运行安装目录可以不同。移动后须更新宿主引用并重新加载。启动参数 dataDir 决定用户数据位置，留空使用本机用户默认目录；显式目录必须由安装者在宿主配置中指定。升级时保留宿主 profile 与其 dataDir，不用发布包覆盖这些配置。

## 首次设置与资料恢复

打开管理台，以新数据目录中的 pairing-code.txt 配对，再到初始化选择已有 DSH 会话或 Yu 管理会话，并明确选择 QQ 对象。历史读取和首次记忆构建需用户单独确认。模型密钥由 DSH 管理。

配置 JSON 用于设置、上下文、任务、触发规则和接入定义；它不备份个人长期记录、聊天或外部资料文件。个人长期库在记忆页面先预览再导入，外部资料通过只读来源登记本机路径。私人数据库、密钥、日志、导入文件与宿主配置均不应加入 Git 或发布包。

## 开发与打包

npm test、npm run check 运行后端验证；npm ci --prefix web 后可运行 README 中的 TypeScript 检查与 npm run build:web。npm pack --dry-run 可预览发布清单，npm pack 生成安装压缩包。
