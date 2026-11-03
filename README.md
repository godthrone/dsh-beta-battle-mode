# BETA 作战模式（dsh-beta-battle-mode）

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的**多智能体预设**：一个指挥官统一调度，执行者负责端到端实现，审查者对照用户原始诉求做全局复核。

名字取自《Muv-Luv Alternative》里的 BETA —— 由 Hive 统一控制、个体没有独立意志的集群。这里借的是那个结构：**指挥权集中，执行权下放**。

它的核心不是"多派几个 agent"，而是解决多智能体最容易崩的两件事：**上下文爆炸** 和 **指挥官自己下场干活**。

## 它解决什么问题

普通长会话到几十万 token 时，压缩要靠模型把整段对话再读一遍再摘要——会话越大越贵、越容易失败，最后卡死在"要压缩才能继续，压缩又装不下"。

BETA 换了个思路：**状态不放在对话里，放在项目的两个 Markdown 文件里**。

```
.local/work_log_current.md    当前状态（宪法 §17.5 状态区）
.local/work_log_history.md    已归档的事件
.local/work_log_digest.md     历史要点（压缩前自动生成）
```

压缩时不再调用模型，而是**直接读这三个文件**当新的上下文：

```
context = 系统提示词 + 工具 + [current 全文 + 历史要点 + 最近一轮对话] + 新一轮
                                        ↑ 一条 checkpoint 消息
```

结果：压缩**零模型请求**、耗时亚秒级、**会话再大也能压**（不会再有"摘要请求装不下"）。实测 7.4 万 token 的会话压到 2.7 万，且不需要任何额外调用。

## 三个角色

| 角色 | 职责 |
|---|---|
| **指挥官**（Commander） | 执行 OODA 循环、设计工作包、派活、验收。**不自己动手改代码** |
| **执行者**（Executor） | 端到端完成一个工作包，交付前自查 |
| **审查者**（Reviewer / 总参谋长） | 对照用户原始诉求做全局复核，是最后防线 |

串行流水线（执行 → 全局审查 → 修正循环）替代树形指挥，避免"下游都以为上游做对了"。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-beta-battle-mode

# 或直接从 GitHub
dsh plugin --profile web add github:godthrone/dsh-beta-battle-mode
```

装完 **不会改变你的默认模式**。新建会话时在模式选择里挑「BETA作战模式」即可。

## 三条硬约束（重要）

### 1. 它不写死适配哪个 DSH 版本

`engines.dsh` 只有下界（`>=0.2.0`），没有上界。插件运行时会**从你正在跑的 DSH 安装里加载所有 `@deepseek-ai/*` 依赖**（不是从自己的 `node_modules`），所以：

- DSH 升级 → 插件自动跟着用新版本；
- API 真不兼容 → 启动时报明确的错，而不是静默半残：

```
badge compaction: 无法初始化：@deepseek-ai/dsh-compaction-basic 0.2.1-rc.2 缺少必需方法 compactNow；
当前宿主 @deepseek-ai/dsh 0.2.1-rc.2 与该 DSH 版本不兼容，请升级/降级插件。
```

### 2. 想改，请改在你自己的 profile 层

DSH 的层叠顺序是 **bundle 层 → 你的 profile patch 层**。直接改包内文件，升级一次就没了。

正确做法：在 `~/.dsh/profiles/<你的profile>/cordis.patch.yml` 里覆盖，那一层优先级最高：

```yaml
# 例：改指挥官人格
- insert:
    - id: preset-beta-battle-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        - id: persona
          config:
            text: |
              ……（你自己的指挥官提示词）
```

### 3. 用「创造模式」适配，比等我们更新快

官方插件我们基本只是**引用 + 少量配置覆盖**。如果你的 DSH 版本、模型、工具链和我们的不一样，最快的路子是：

> 开一个创造模式会话，让它读 `node_modules/dsh-beta-battle-mode/cordis.patch.yml`，
> 然后按你的环境改一遍，写进你的 profile 层。

我们负责提供参考实现，适配交给你和你的 agent —— 这样我们不用追版本，你也不用等。

## 组成部分

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | 预设定义：persona（387 行）+ 29 条插件声明（官方插件为主） |
| `lib/compaction-badge.js` | 压缩引擎：读工作日志当 checkpoint，零模型调用 |
| `lib/goal-round-reminder.js` | goal 续轮时追加指挥官提醒 |

压缩流程：

```
指挥官一轮结束（空闲）
  → 到阈值？→ 发一轮"更新工作日志 + 写历史要点"
  → 那一轮结束 → 读三个文件压缩
```

全程不在轮次中间打断，也不会和下级通知抢时间。

## 已知边界

- **没有 plan 模式**（指挥官做决策不需要审批门）；
- **没有 `ask_user_question` / 图表渲染**（刻意保持窄口径）；
- 强依赖 `badge-constitution` skill（[公开仓库](https://github.com/godthrone/badge-development-constitution)），未安装时会降级为对话内约束；
- 压缩质量取决于工作日志的质量 —— 日志写得烂，压缩后就烂。这是设计取舍，不是 bug。

## 版本

我们跟自己的语义化版本走，不追 DSH 的版本号：

| 我们的版本 | 含义 |
|---|---|
| 0.1.x | 参考实现，可能调整 checkpoint 结构 |
| 0.2.x | 行为变更（例如压缩触发时机） |

## License

MIT
