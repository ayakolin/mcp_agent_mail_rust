# Agent Mail Wake integrations

[中文安装与使用说明](README.zh-CN.md) · [Fork overview](../../README.zh-CN.md) · [Verification](VERIFICATION.md)

These optional integrations connect MCP Agent Mail's durable inbox events to
running coding-agent sessions. They are fork-maintained additions, separate from
the upstream Rust server. The implementation uses Node.js built-ins and has no
external package dependencies.

| Client | Adapter | Launch |
| --- | --- | --- |
| Oh My Pi / OMP | Native extension, idle-gated `sendMessage` | `omp` |
| Codex | Managed App Server plus native remote TUI | `codex-mail` |
| Claude Code | Local MCP Channel plus native TUI | `claude-mail` |
| Kimi Code | Managed Web/API session | `kimi-mail` |

Grok Build wake support is not included. A configured MCP connection alone does
not automatically wake a client. These integrations do not take over arbitrary
already-running sessions.

## Install

Prerequisites: Node.js 24+, the selected clients with working model credentials,
and a running Agent Mail server exposing `fetch_inbox_events`. The original
integration was tested against Agent Mail 0.3.32. Install the Rust service using
the [upstream instructions](../../README.md#installation) if needed.

From the repository root:

```sh
node integrations/agent-mail-wake/install.mjs --dry-run
node integrations/agent-mail-wake/install.mjs
```

Select individual clients if desired:

```sh
node integrations/agent-mail-wake/install.mjs --clients omp,codex
```

The installer creates launchers under `~/.local/bin`, copies runtime sources into
`~/.local/share/agent-mail/wake` (using `XDG_DATA_HOME` when set), installs an OMP
entry point and/or registers the Claude Channel, and adds missing `mcp_agent_mail`
entries to the selected clients. Existing Agent Mail entries and unrelated
configuration are preserved. Originals are backed up before replacement.
Ensure the launcher directory is on your `PATH`.

Options: `--home`, `--prefix`, `--bin-dir`, `--clients`, `--url`, `--dry-run`.
`--home` is useful for isolated installation tests. `--url` accepts loopback HTTP
only. Existing MCP endpoints are not rewritten: keep them consistent with the
listener's endpoint. The initial setup targets a local service accessible without
a bearer token; authenticated deployments must adapt the HTTP headers in both the
mail client and their native MCP configuration.

## Use

Start each client from the same project directory. Each session registers its own
mailbox. Discover recipient names with:

```sh
agent-mail-wake list
agent-mail-wake doctor
```

Ask agents to use their registered identity and send messages through the existing
`mcp_agent_mail` tools. The listener delivers messages automatically. Mail remains
peer input within the user's task; it does not grant new privileges.

OMP exposes `/mail-wake status|pause|resume|start`. Other listeners can be controlled
using their ID:

```sh
agent-mail-wake pause LISTENER_ID
agent-mail-wake resume LISTENER_ID
```

Claude's custom Channel uses its development-channel startup flag and requires the
client's local-channel confirmation. Plain `claude` keeps the added Channel MCP
server passive. Kimi prints its Web UI URL and uses the existing `server.token`;
its adapter does not attach to an unrelated live Kimi TUI.

Default polling is 3 seconds, with at most 5 events per batch and a pause after 8
automatic deliveries. The polling itself does not invoke a model. Configure with
`AGENT_MAIL_WAKE_INTERVAL_MS` and `AGENT_MAIL_WAKE_MAX_TURNS`.
See the Chinese guide for full session-resume commands and lifecycle details.

## Persistence and delivery limits

The watcher stores a delivery cursor and pending batch before submission. It
advances the cursor only after the receiving adapter accepts the batch. Codex
checks thread history, Kimi uses a stable `prompt_id`, and OMP checks custom-message
records when reconciling retries. A cursor gap pauses instead of skipping history.
These mechanisms do not provide exactly-once execution of an agent's tools.

Claude Channel success means the notification was written to MCP, not that the
model finished processing it. A crash around that boundary can repeat or miss a
wake notification; the original mail remains in Agent Mail. Tool approvals still
need the client's normal approval flow, including for a headless Codex session.

Runtime state, bindings, logs and backups stay under the user data directory
(`AGENT_MAIL_WAKE_HOME` overrides it); `AGENT_MAIL_WAKE_STATE_DIR` overrides only
the cursor directory. They must not be committed. The repository contains a
source-only import of the original local integration.

## Files and tests

| File | Purpose |
| --- | --- |
| `common.mjs` | Mail protocol, identities, batching, durable cursor and pause controls |
| `omp.mjs` | OMP extension lifecycle and incoming-message delivery |
| `claude-channel.mjs` | Claude's stdio MCP Channel and control tools |
| `rpc.mjs` | Codex App Server and Kimi Server API adapters |
| `cli.mjs` | Shared launcher, session binding, status and lifecycle commands |
| `install.mjs` | Portable installer for sources, launchers and client config |
| `test/` | Behavioral watcher/adapter tests and real filesystem installation tests |

```sh
node --test integrations/agent-mail-wake/test/*.test.mjs
```

The fork includes a path-scoped GitHub Actions workflow for these tests. Tests do
not invoke a model or require the Agent Mail service. Live-client verification
from the original installation is documented separately in `VERIFICATION.md`.

Repository licensing is governed by the complete [root LICENSE](../../LICENSE).
