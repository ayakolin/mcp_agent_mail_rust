# Agent Mail：多客户端自动唤醒 fork

这是 [ayakolin/mcp_agent_mail_rust](https://github.com/ayakolin/mcp_agent_mail_rust)，基于
[Dicklesworthstone/mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)
创建的个人 fork。

这个 fork 保存了为 OMP、Codex、Claude Code 和 Kimi Code 编写的自动唤醒适配。
Agent Mail 原本提供邮箱、收发信和持久化；这里新增的监听器读取新邮件事件，
再通过各客户端的原生接口启动回复，让多个已打开的会话能够相互协作。

| 客户端 | 新增内容 | 启动方式 |
| --- | --- | --- |
| OMP / Oh My Pi | 原生扩展；自动注册身份；空闲时通过 `sendMessage` 触发回复 | `omp` |
| Codex | App Server 会话启动器；通过 `turn/start` 投递 | `codex-mail` |
| Claude Code | 本地 MCP Channel；将收件事件推送到原生终端 | `claude-mail` |
| Kimi Code | Web/API 会话启动器；提交幂等提示并绑定已配置的默认模型 | `kimi-mail` |
| Grok Build | 本 fork 尚无自动唤醒适配 | — |

新增源码、安装程序和测试集中在 **[integrations/agent-mail-wake/](integrations/agent-mail-wake/)**。
服务端 Rust 代码、上游发布流程和原有协议保持上游版本。
fork 建立时的上游提交为 `bfa84b85d2b0fd426a2d659a547865b38db66706`。

## 安装与使用

先按[上游 README](README.md#installation)安装并运行 Agent Mail，同时准备 Node.js 24+
和需要使用的客户端及其登录配置。已运行 Agent Mail 的机器不需要再次安装服务端。

```sh
git clone https://github.com/ayakolin/mcp_agent_mail_rust.git
cd mcp_agent_mail_rust
node integrations/agent-mail-wake/install.mjs --dry-run
node integrations/agent-mail-wake/install.mjs
```

安装器会复制运行代码、创建启动命令、合并各客户端的用户配置，并备份被修改的文件。
默认服务地址为 `http://127.0.0.1:8765/mcp/`。
现有 MCP 服务配置和身份认证设置会保留。

然后在同一项目目录的不同终端分别启动 `omp`、`codex-mail`、`claude-mail` 或 `kimi-mail`。
Kimi 使用启动器显示的 Web 页面。运行 `agent-mail-wake list` 查看自动注册的邮箱名称，
让 Agent 给目标邮箱发送消息即可。无需再为同一会话注册第二个身份。

详细配置、恢复会话、暂停、限制和排错请看 **[自动唤醒安装与使用说明](integrations/agent-mail-wake/README.zh-CN.md)**。

## 默认行为与验证范围

- 每 3 秒检查新收件事件，每批最多合并 5 条。
- OMP、Codex、Kimi 等待会话可以接收时提交；Claude 使用 Channels 的原生投递机制。
- 使用持久游标和待投递批次，连续 8 批自动唤醒后暂停，可手动恢复。
- 本地轮询不调用模型；新信被投递后，客户端按自己的模型和权限配置运行。
- 邮件协作不会放宽客户端原有的工具审批和沙箱策略。

原始实现已在 Linux 上验证四个客户端收到新信后触发模型响应。
本 fork 另外测试了安装器的配置合并、备份、重复安装、路径转义，以及监听器和适配器的边界行为。
各客户端的版本和验证范围记录在[验证说明](integrations/agent-mail-wake/VERIFICATION.md)。

```sh
node --test integrations/agent-mail-wake/test/*.test.mjs
```

仓库保存源码、测试和通用文档，不包含本机邮箱数据库、邮件正文、认证令牌、
会话 ID、服务日志或客户端个人配置。源码默认把运行状态写到用户数据目录；
集成目录也配置了相应的 Git 忽略规则。

本 fork 保留上游版权声明及根目录 [LICENSE](LICENSE) 的完整条款。
