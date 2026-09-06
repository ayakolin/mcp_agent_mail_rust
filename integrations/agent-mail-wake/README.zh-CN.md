# Agent Mail 自动唤醒：安装与使用

[English](README.md) · [Fork 说明](../../README.zh-CN.md) · [验证范围](VERIFICATION.md)

这套适配读取 Agent Mail 的持久收件事件，把消息送到 OMP、Codex、Claude Code、
Kimi Code、Grok Build 和 OpenCode 的会话中，并触发下一轮回复。它来自本 fork 的本地集成，使用
Node.js 标准库，不需要安装额外的 npm 依赖。Grok Build 与 OpenCode 使用启动器托管的
无头会话（分别为 `grok agent stdio` ACP 与 `opencode serve` REST），不接管已有终端窗口。

## 前置条件

- Node.js 24 或更新版本。
- 已安装、已登录的目标客户端，以及可用的模型配置。
- 已运行的 MCP Agent Mail 服务，包含 `fetch_inbox_events`。原始实现使用 0.3.32。
- 默认 MCP 地址 `http://127.0.0.1:8765/mcp/`；消息面板 `http://127.0.0.1:8765/mail/`。

首次安装服务端请参考[上游安装说明](../../README.md#installation)。
本目录的安装器只安装客户端适配，不下载模型、不启动 Agent Mail 服务。

## 安装

在仓库根目录运行：

```sh
node integrations/agent-mail-wake/install.mjs --dry-run
node integrations/agent-mail-wake/install.mjs
```

只安装部分客户端时：

```sh
node integrations/agent-mail-wake/install.mjs --clients omp,codex,claude
```

默认复制到 `~/.local/share/agent-mail/wake/`，启动命令放入 `~/.local/bin/`。
确保该目录在 `PATH` 中。设置了 `XDG_DATA_HOME` 时，运行目录改用
`$XDG_DATA_HOME/agent-mail/wake/`。

安装器会合并配置并在覆盖前备份原文件；不会改动其他 MCP 条目、模型配置或原有权限规则。
已有的 `mcp_agent_mail` 条目会完整保留，包括其认证信息和禁用状态。

| 客户端 | 安装位置 |
| --- | --- |
| OMP | `~/.omp/agent/extensions/agent-mail-wake/index.ts` 和 `~/.omp/agent/mcp.json` |
| Codex | `~/.codex/config.toml` 中缺失的 Agent Mail 连接，以及 `codex-mail` |
| Claude Code | `~/.claude.json` 中的 Agent Mail 连接和 `agent_mail_wake` Channel，以及 `claude-mail` |
| Kimi Code | `~/.kimi-code/mcp.json` 中缺失的连接，以及 `kimi-mail` |
| Grok Build | `~/.grok/config.toml` 中缺失的 Agent Mail 连接，以及 `grok-mail` |
| OpenCode | `~/.opencode/opencode.json` 中缺失的 Agent Mail 连接，以及 `opencode-mail` |

可选参数：

| 参数 | 用途 |
| --- | --- |
| `--dry-run` | 仅列出会改动的路径，不写入 |
| `--clients omp,codex,claude,kimi,grok,opencode` | 选择客户端 |
| `--home DIR` | 使用明确的用户目录，适合隔离验证 |
| `--prefix DIR` | 指定运行代码安装目录 |
| `--bin-dir DIR` | 指定启动命令目录 |
| `--url URL` | 指定本机 HTTP Agent Mail 地址 |

使用默认用户目录时，安装器识别 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`KIMI_CODE_HOME`、
`GROK_HOME`、`OPENCODE_CONFIG_DIR` 和 OMP 的 `OMP_PROFILE` / `PI_CODING_AGENT_DIR`。
如果已有 MCP 配置指向不同地址，请让监听器和各客户端使用同一个服务。
当前默认安装面向本机可直接访问的服务；当服务端配置了 `HTTP_BEARER_TOKEN`
（上游安装器即如此），`MailClient` 会自动从 `AGENT_MAIL_BEARER_TOKEN` 环境变量或
`~/.config/mcp-agent-mail/config.env` 读取令牌，各客户端原生 MCP 条目需带上匹配的请求头。

## 开始协作

在同一个项目目录开多个终端，分别运行：

| 客户端 | 命令 | 界面 |
| --- | --- | --- |
| OMP | `omp` | 原生终端；扩展自动加载 |
| Codex | `codex-mail` | 原生 Codex 终端，连接启动器管理的 App Server |
| Claude Code | `claude-mail` | 原生 Claude 终端，启用本地 Channel |
| Kimi Code | `kimi-mail` | 打开输出的 Web UI 地址 |
| Grok Build | `grok-mail` | 无原生界面；启动器托管 ACP 会话并回显模型回复 |
| OpenCode | `opencode-mail` | 无原生界面；启动器托管 `opencode serve` 会话并回显回复 |

查看邮箱和监听状态：

```sh
agent-mail-wake list
agent-mail-wake doctor
```

每个会话会注册独立身份。把目标邮箱名告诉发送方，例如：

> 使用你当前的 Agent Mail 身份，给 BlueLake 发一封邮件，询问接口字段是否已确定。

接收方保持对应客户端或启动器运行，就会在收到新信后启动回复。
所有参与方使用同一个项目绝对路径；不要为同一会话另注册第二个邮箱。

Claude 首次使用自定义 Channel 的启动入口时，会要求确认这是本地开发的 Channel。
这个要求由 Claude 自己执行。启动器仅启用 `server:agent_mail_wake`，
不启用跳过工具权限检查的选项。直接运行普通 `claude` 时，Channel MCP 保持被动。

Kimi 使用 `~/.kimi-code/server.token` 中的本地认证令牌。浏览器要求认证时，使用该文件中的值。
新建 API 会话会显式绑定现有默认模型，以处理测试版本中 API 新会话没有自动选择模型的行为。
Kimi 适配器管理 Web/API 会话，不会同时接管另一个正在运行的 Kimi TUI。

## 默认行为和控制

- 每 3 秒检查收件事件，每批最多合并 5 条；检查本身不调用模型。
- 邮件直接注入正在进行的回合，而不是等会话空闲：OMP 用 `deliverAs: "aside"`
  在下一个步骤边界注入，Codex 用 App Server 的 `turn/steer`，Kimi 先提交到提示队列
  再立即用 `prompts:steer` 转入活动回合，OpenCode 用 `delivery: "steer"` 提交，
  Claude 由 Channels 原生机制投递。仅当会话处于错误状态（或 Codex 正处于不可转向的
  review/compact 回合）时才会延迟投递。
- 持久保存已处理游标和待投递批次，使用 delivery cursor，不使用 message_id 作为游标。
- 网络失败保留待处理批次；游标缺口会暂停，不会静默跳过历史。
- 连续 8 批自动唤醒后暂停；显式恢复会清零计数。OMP 正常用户输入会重置尚未暂停会话的计数。
- 收件内容属于用户已授权任务中的同伴输入，不会授予新的工具、文件或沙箱权限。

```sh
agent-mail-wake pause LISTENER_ID
agent-mail-wake resume LISTENER_ID
```

OMP 界面还支持 `/mail-wake status`、`/mail-wake pause`、`/mail-wake resume`、`/mail-wake start`。

调整本次启动的参数：

```sh
AGENT_MAIL_WAKE_INTERVAL_MS=5000 AGENT_MAIL_WAKE_MAX_TURNS=12 codex-mail
AGENT_MAIL_WAKE_ENABLED=0 omp
```

普通 OMP RPC、print 和子任务默认不会自动注册邮箱；明确需要时设置 `AGENT_MAIL_WAKE_ENABLED=1`。

## 恢复会话和退出

```sh
codex-mail --project /absolute/project --session CODEX_THREAD_ID
claude-mail --project /absolute/project --session CLAUDE_SESSION_ID
kimi-mail --project /absolute/project --session KIMI_SESSION_ID
```

这些恢复入口面向已经停止、由适配器管理过的会话。不要同时在两个进程里恢复同一会话。
连接一个明确的现有服务时，可以指定：

```sh
codex-mail --project /absolute/project --server ws://127.0.0.1:PORT --session THREAD_ID
kimi-mail --project /absolute/project --server http://127.0.0.1:PORT --session SESSION_ID
```

`codex-mail --headless` 保留无终端的监听器并显示终端连接命令；遇到权限请求时需要在原生界面处理。
Codex / Claude 原生参数放在 `--` 后面，例如 `claude-mail -- --effort medium`。

退出启动器会停止它创建的客户端服务和监听器。通过 `--server` 连接的外部服务不会被停止。
Agent Mail 主服务独立运行，不受启动器退出影响。

## 投递保证与限制

Codex 查询会话历史（转向投递的批次还会在生成的用户消息上携带 `clientUserMessageId` 批次 ID）、
Kimi 使用稳定的 `prompt_id`、Grok 在启动器本地绑定账簿中记录已受理
批次 ID、OpenCode 扫描会话历史中的投递标记、OMP 查询自定义消息记录来减少重试重复。
这些措施不保证 Agent 执行工具的 exactly-once 语义。
Claude Channel 的成功表示通知已写入 MCP 通道；崩溃发生在这个边界时，唤醒可能重复或遗漏一次，
但原邮件仍保存在 Agent Mail 中。必要时可主动查询 `fetch_inbox`。

各客户端协议随版本演进，测试版本见[验证说明](VERIFICATION.md)。
当前只支持本机回环连接；没有远程部署或任意现有窗口接管功能。
Grok 适配器以 always-approve 运行托管会话，接入敏感工作区前先确认这一边界。

## 运行数据与测试

默认运行目录为用户数据目录下的 `agent-mail/wake/`。
`AGENT_MAIL_WAKE_HOME` 可覆盖整个目录；`AGENT_MAIL_WAKE_STATE_DIR` 仅覆盖游标目录。

| 子目录 | 内容 |
| --- | --- |
| `state/` | 邮箱身份、游标、暂停状态和进程锁 |
| `bindings/` | 会话 ID 与本地服务地址 |
| `logs/` | 客户端服务日志；限制为当前用户可读 |
| `backups/` | 安装器修改前的原文件和清单 |

这些本机数据不应进入 Git。仓库只包含源码、测试、安装器及通用文档。
测试直接使用 Node 的内置测试运行器，不安装依赖：

```sh
node --test integrations/agent-mail-wake/test/*.test.mjs
```

参考接口：[OMP 扩展](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)、
[Codex App Server](https://learn.chatgpt.com/docs/app-server)、
[Claude Channels](https://code.claude.com/docs/en/channels-reference)、
[Kimi Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html)。
