# dsh-checkpoint-dock

在 DeepSeek Harness 的输入框上方常驻一个 IDE 风格的检查点 dock，按轮次列出 agent 改过的文件；对话流里仍保留 DSH 自带的“已编辑 N 个文件”卡片。

界面里的编号按**会话内顺序**显示（第 1 个检查点就是“检查点 1”），不再直接露出 DSH 的 raw turn 编号；raw turn 仍作为记录键、存储键和跳转目标保留，悬停标题可以看到。设置总览的会话下拉和行内标签优先通过公开的 `ctx.sessions` + `ctx.sessionTitle` 读取 DSH 会话标题；标题服务不可用时回退到 session projection cache 的 `record.rows.title.val`；旧会话两处都没有标题时，退回该会话最早一条检查点的提示词，再退回工作区目录名。


- **保留**：接受这一轮及其之前所有未撤销的修改；保留是顺序累积的，只能从最新的活跃检查点开始。
- **撤销**：把这一轮第一次修改前的文件字节恢复回去；新建的文件会删除，第二次点击确认。撤销后按钮变成**重做**。
- **重做**：重新应用这一轮结束时的文件状态；只能按“后进先出”顺序重做，新的活跃检查点会挡住重做。
- **回退到此**：把文件恢复到这一轮结束时的状态，Host 端先完整预检整条链再一次性应用，不会只回退一半。对话不会回退；跨过已保留检查点需要二次确认。
- **查看变更**：在 dock 内展开这一轮的 before/after diff；文件行仍可打开 DSH 自带的 changes-review 侧栏。
- **筛选**：dock 顶部可按 全部 / 记录中 / 未处理 / 已保留 / 已撤销 过滤；默认显示最近 30 条，可点“加载更早”继续展开；存储列表接口同时支持 `limit`/`offset`。
- **钉住 / 存储**：钉住只是保护存储内容，不改变接受状态；存储面板可查看占用并手动清理旧内容。
- **设置**：设置 → 检查点（和“通用设置/模型”同级），分“总览 / 配置”两页。总览列出所有会话的检查点，Dock 隐藏时也能回看；配置可开关“常驻显示”和“点击跳转对话”。常驻关闭时，只有出现尚未处理的文件改动（记录中/未处理）才显示 Dock，处理完就收起。设置按浏览器保存在 cookie（同机不同端口也有效），localStorage 作为回退。

## 保留、撤销与重做

撤销 N 恢复的是“第 N 轮第一次写这些文件之前”的磁盘内容，而不是“点击保留那一刻”的内容。保留本身不改文件。

- 保留最新一条会把之前所有未撤销的检查点一并标记为已保留。
- 只要某个检查点之后有已保留的检查点，早于它的检查点就不能再单独撤销，即使两轮改的是不同文件；需要整体回退时用“回退到此”。
- 单个撤销会先校验每个文件的当前 hash 是否等于该轮结束时的 hash；文件被别的工具或手工改过就报冲突，不会强行覆盖。
- 同一工作区里的另一个会话如果在这条检查点之后也改过同一个文件（或当前还在记录该文件），撤销/重做/回退会直接拒绝，并提示另一个会话的短 ID；不会把对方的修改当成自己的回退。记录本身按 `(session, turn)` 隔离，从不互相覆盖。
- 重做只允许从最早的已撤销检查点开始，依次向后；中间有更新的活跃检查点时不能重做。
- 回退会撤销目标之后的所有检查点；这些记录进入 `undone`，可再按顺序重做。

## 存储与保护

- 数据目录：`$DSH_HOME/edit-checkpoints/`，每个 `(session, turn)` 一条 JSON 记录。
- before/after 字节放在内容寻址 blob 中；文件模式（非 Windows）随快照保存。
- **钉住**：仅对 sealed/kept/undone 可用；不改变文件、状态或保留级联，只是让内容不参与清理。已清理的内容不能靠钉住复活。
- **清理旧内容**：手动触发，保留最近 30 条和所有钉住项，只删除更早、未钉住的 blob；记录本身保留为 `contentRemoved` 元数据，diff/撤销/重做会禁用。
- `.env*`、私钥、`.ssh/.aws/.gnupg` 等敏感路径默认不进入检查点；这是硬编码保守策略，不替代密钥管理。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | Host 插件：监听 `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`，写入前保存原字节；`workspace/changes` / `turn/end` 结算；`turn/start` 恢复上一次崩溃遗留的 open 记录。 |
| `lib/store.mjs` | 记录、内容寻址 blob、diff、撤销/重做/回退、保留级联、钉住、清理、跨进程锁和路径/敏感文件守卫。 |
| `lib/service.mjs` | Typert Remote 服务 `editCheckpoints`，暴露 `get` / `keep` / `undo`；用 turn 哨兵复用启动时已注册的路由。 |
| `lib/wire.mjs` | Host 端 Typert 描述符。 |
| `typert.host.mjs` | Typert host manifest。 |
| `client/index.js` | 浏览器端模块：输入框上方的 dock、diff、存储面板和 Remote 调用。 |
| `cordis.patch.yml` | 插件行声明。 |

## 安装

从 npm（发布后）：

```powershell
dsh plugin --profile desktop add dsh-checkpoint-dock
```

从本地目录：

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-checkpoint-dock
```

或在插件页选择本地 bundle。安装后刷新页面；如果本次安装新增了 Host 端 bundle 或 Typert 方法，需要重启 DSH 才能完成路由注册。

## 安全与隐私

- 检查点数据以明文保存在 `$DSH_HOME/edit-checkpoints/`，包含被修改文件的内容；不要把这个目录提交到仓库，也不要同步到不可信位置。
- 默认跳过 `.env*`、私钥、`.ssh/.aws/.gnupg` 等敏感路径，但这是启发式保护，不是加密，也不能替代密钥管理。
- 只捕获 DSH 文件工具发起的写入；Shell、构建脚本、git 和外部编辑器直接写文件不会进入检查点。
- 单文件上限为 4 MiB；超过上限的文件只记录近似行数，不参与安全撤销。

## 发布

发布使用 GitHub Release 触发，不再在 `push main` 时自动改版本（避免版本提交循环）。

1. 修改 `package.json` 的 `version`，提交到 `main`。
2. 创建并推送 tag，例如 `v0.1.0`。
3. 在 GitHub 创建 Release，选择该 tag 并发布。
4. `.github/workflows/npm-publish.yml` 会校验 tag 与 `package.json` 版本一致，执行语法检查，然后用仓库 secret `NPM_TOKEN` 发布到 npm。

`NPM_TOKEN` 需要 npm Automation token（或具备 publish 权限的 granular token），并在仓库 Settings → Secrets and variables → Actions 中配置。

## 已知限制

- 只处理 `session.header.cwd` 内的文件；工作区外与临时文件不进入检查点。
- Shell、构建脚本、git、外部编辑器直接写文件不会经过 DSH 的文件工具，因此不会被捕获。
- 单文件超过 4 MiB 或 diff 矩阵超过 400 万格时只显示近似行数，且不参与安全撤销。
- 只恢复文件字节与 mode；不恢复 mtime、目录、符号链接目标或 `.git` 元数据。
- 撤销/回退是覆盖式恢复：不会删除本轮之外新建的文件。
- 本轮结束后文件再被其他工具改动时，撤销会报告冲突并保持文件不动。
- 跨会话保护只在撤销/重做/回退时检查，不是持续性的文件编辑锁。两个会话仍然可以同时写同一个文件；如果对方的写入发生在本轮封存之前，本轮 after 可能已经包含对方字节，之后撤销仍会按本轮快照恢复。要彻底避免，需要工作区级的写入串行化。
- 多个 DSH 进程共享同一存储目录时靠 `.store.lock` 串行化；锁超过 120 秒视为陈旧，可能被接管。
- 新增 Typert 方法在 DSH 未重启时没有网关路由，所以列表/统计/钉住/清理复用 `get`/`keep`/`undo` 的 turn 哨兵。
- v1 旧记录没有 after blob，diff/重做不可用；不做自动迁移。
