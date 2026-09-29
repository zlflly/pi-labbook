# pi-labbook

一个与 Pi `/tree` 联动的实验记录、笔记和长期记忆扩展。

`/lab start` 会在当前 Session 中建立一个分支锚点，后续讨论只存在于 Lab 分支。`/lab cancel` 会回到开始前的对话位置，同时完整保留 Lab 讨论供 `/tree` 查看。`/lab save` 会把讨论整理为结构化 Markdown，显示发布确认，提交到独立 Git 仓库并推送到 GitHub，然后回到开始前的对话位置。

## 功能

- 三种记录类型：`experiment`、`note`、`memory`
- 使用 Pi 原生 Tree 保存完整讨论分支
- 分支状态随 Session 保存，支持恢复和手动 Tree 导航
- 保存前展示目标仓库、分支、文件路径和 Markdown 预览
- 只 stage 扩展生成的单个文件
- 仓库不干净、分支错误、远端不匹配时拒绝写入
- `git pull --ff-only` 和普通 fast-forward push，绝不 force-push
- 私钥、GitHub Token、AWS Key、明显密码/API Key 扫描
- GitHub Push 失败时保留本地 commit
- 支持多设备使用同一个私人记录仓库

## 安装

Pi 需要 `>= 0.87.1`。

```bash
pi install git:github.com/zlflly/pi-labbook
```

在已经运行的 Pi 中执行：

```text
/reload
```

开发版本也可以直接从本地加载：

```bash
pi install ~/Projects/pi-labbook
```

## zlflly 的私人记录仓库

本扩展的作者配置使用私人仓库：

```text
https://github.com/zlflly/labbook
```

作者自己的设备应执行：

```bash
mkdir -p ~/Projects
git clone https://github.com/zlflly/labbook.git ~/Projects/labbook
```

这是私人仓库，其他 GitHub 用户没有权限时无法 clone。其他用户应创建自己的私人仓库，并在配置中替换 `repoPath` 和 `expectedRemote`。

## 配置

在每台设备创建 `~/.pi/agent/labbook.json`：

```json
{
  "version": 1,
  "repoPath": "~/Projects/labbook",
  "recordsDir": "records",
  "remote": "origin",
  "branch": "main",
  "expectedRemote": "https://github.com/zlflly/labbook.git",
  "publishMode": "confirm",
  "secretScan": true
}
```

也可以通过 `PI_LABBOOK_CONFIG` 指定其他配置文件。配置是设备本地的，不应提交到公共扩展仓库，因为每台设备的 clone 路径可能不同。

字段说明：

| 字段 | 说明 |
|---|---|
| `repoPath` | 私人记录仓库的本地绝对路径或 `~/...` 路径 |
| `recordsDir` | 仓库内允许写入的记录根目录 |
| `remote` | Git remote 名称 |
| `branch` | 要 pull/push 的分支 |
| `expectedRemote` | 预期远端 URL，防止误推到其他仓库 |
| `publishMode` | `confirm` 每次确认并 push；`local-only` 只创建本地 commit |
| `secretScan` | 保存前启用高置信度敏感信息检查 |

运行以下命令检查配置及仓库：

```text
/lab config
```

## 使用

### 开始讨论

```text
/lab start experiment EasyConnect 与 SSH 代理实验
/lab start note Pi 扩展架构
/lab start memory Git 发布安全原则
```

省略类型时默认为 `note`：

```text
/lab start 多设备同步设计
```

Pi 会进入 Lab 模式，与你澄清目标、事实、观察、决策和结论。在保存之前，扩展不会写记录仓库。

### 查看状态

```text
/lab status
```

### 保存并发布

```text
/lab save
/lab save 重点保留失败原因和下一步实验
```

保存流程：

1. 当前模型把 Lab 分支整理为结构化记录；
2. 扩展执行敏感信息扫描；
3. 验证仓库、分支、远端和工作区清洁状态；
4. `git pull --ff-only`；
5. 显示记录预览并要求确认；
6. 原子写入一个 Markdown 文件；
7. 只 stage 该文件并 commit；
8. push 到配置的 GitHub 分支；
9. 回到 `/lab start` 前的 Tree 锚点。

如果拒绝发布或保存失败，会留在 Lab 分支，以便修改和重试。

### 取消

```text
/lab cancel
/lab cancel 暂时不值得记录
```

取消不会写入仓库。扩展会回到 `/lab start` 前的对话位置，但完整讨论仍然保存在 `/tree` 的另一个分支，并带有 `lab: ... (cancelled)` 标签。

## Tree 行为

```text
原对话 A ─ B ─ [Lab anchor] ─ 正常对话（save/cancel 后继续）
                         └─ Lab start ─ 讨论 ─ 保存或取消
```

扩展使用：

```typescript
await ctx.navigateTree(anchorId, { summarize: false });
```

因此 Lab 分支内容不会被摘要带回原对话。Tree 导航只改变对话上下文，不会撤销已经完成的 Git commit 或 GitHub push。已经发布的记录如需撤销，应创建新的修订或 revert commit，不能依赖 `/tree`。

## 多设备使用

每台设备都执行以下步骤。

### 1. 配置 GitHub 身份

推荐使用 GitHub CLI：

```bash
gh auth login
gh auth setup-git
```

也可以使用 SSH remote 和 `ssh-agent`。不要把 Token 写入 `labbook.json`。

### 2. 安装扩展

```bash
pi install git:github.com/zlflly/pi-labbook
```

更新未固定版本的安装：

```bash
pi update --extensions
```

如需固定版本：

```bash
pi install git:github.com/zlflly/pi-labbook@v0.1.1
```

### 3. Clone 私人记录仓库

作者设备：

```bash
git clone https://github.com/zlflly/labbook.git ~/Projects/labbook
```

其他用户：

```bash
git clone https://github.com/YOUR_NAME/YOUR_PRIVATE_LABBOOK.git ~/Projects/labbook
```

### 4. 创建设备本地配置

按“配置”一节创建 `~/.pi/agent/labbook.json`，并执行：

```text
/reload
/lab config
```

### 5. 同步原则

- 每次保存前扩展会执行 `pull --ff-only`；
- 仓库存在未提交修改或冲突时，扩展会停止，不会 stash 或覆盖；
- 文件名包含随机 Lab ID，降低多设备同时创建记录时的冲突概率；
- 某台设备 Push 失败时，本地 commit 会保留，应先手动解决同步问题；
- 不要把 Pi 的 Session JSONL 放入记录仓库；只同步最终 Markdown 记录。

## 记录格式

记录保存在：

```text
records/
├── experiments/YYYY/MM/<slug>--<lab-id>.md
├── notes/YYYY/MM/<slug>--<lab-id>.md
└── memories/YYYY/MM/<slug>--<lab-id>.md
```

内容包括：

- Summary
- Objective
- Hypothesis（可选）
- Method
- Observations
- Decisions
- Conclusion
- Next steps
- Artifacts
- Pi Session 与 Tree anchor 元数据

## 安全边界

Pi 扩展与 Pi 进程拥有相同的系统权限。请只安装你信任的版本，并使用专用私人仓库。

本扩展会：

- 拒绝路径穿越和符号链接记录目录；
- 拒绝写入 `.git`、`.github` 或配置目录之外的位置；
- 拒绝脏工作区和错误分支；
- 拒绝不匹配的远端；
- 不执行 force-push；
- 不自动 stash、reset 或清理未知文件；
- 不在 Session 状态中保存 GitHub 凭据。

敏感信息扫描不能保证发现所有秘密。确认发布前仍应人工检查预览。

## 开发

```bash
git clone https://github.com/zlflly/pi-labbook.git
cd pi-labbook
npm install
npm run check
pi -e .
```

项目使用 MIT License。
