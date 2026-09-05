# Verification scope

## Original live installation

The original local integrations were exercised on Linux x86_64 on 2026-09-05:

| Component | Version | Observed result |
| --- | --- | --- |
| Node.js | 24.14.0 | Standard-library runtime |
| Agent Mail | 0.3.32 | Real MCP initialization, discovery, send/read/ack/reply and inbox events |
| OMP | 18.1.10 | Native extension registered a mailbox; incoming mail triggered agent and assistant response events |
| Codex | 0.153.4 | Mail started an App Server turn and produced assistant text; the test stopped when further processing required an interactive approval |
| Claude Code | 2.1.261 | Native Channel accepted; new mail triggered a completed assistant reply and a receipt acknowledgment |
| Kimi Code | 0.41.0 | Incoming mail triggered a completed assistant reply after the API session was bound to the already-configured default model |
| Grok Build | Not available in the test installation | No wake adapter or live verification |

These observations describe that installation, not a guarantee for every future
client version. Account credentials, conversation transcripts, mail bodies,
session IDs, runtime bindings, logs and raw local result files are not published.

## Fork packaging checks

The fork preserves the original adapter sources and makes a small packaging
adjustment: runtime state, logs and bindings use the user data directory instead
of the repository checkout. It also adds a portable installer and removes
machine-specific paths from documentation and generated launchers.

Run the reproducible checks with:

```sh
node --test integrations/agent-mail-wake/test/*.test.mjs
node --check integrations/agent-mail-wake/common.mjs
node --check integrations/agent-mail-wake/cli.mjs
node --check integrations/agent-mail-wake/install.mjs
```

Watcher and adapter unit tests use controlled protocol substitutes for busy
sessions, retries, cursor gaps, duplicate listeners, delivery limits and stable
prompt IDs. They support those local behaviors; they do not replace the live
client evidence above. Installer tests exercise actual files, generated launcher
execution, JSON merging, backups, idempotent reinstall and quoted paths in an
isolated directory. No test sends mail to a real user or invokes a model.

Rust server sources are not changed by this integration. Rust workspace checks
are separate from the Node integration lane; no Rust build or release is claimed
by a passing wake-integration workflow.

Packaging validation on 2026-09-05: **12 Node tests passed**, module syntax checks
passed, and an installer dry run against the existing local configuration made
no changes. The requested `cargo check`, `cargo clippy`, and `cargo fmt --check`
commands could not load the upstream workspace because the checkout lacks the
external `../frankensearch-rel-0332/frankensearch/Cargo.toml` path dependency.
No Rust source or dependency lockfile was edited. The upstream `br` and `ubs`
helper tools were not installed on this machine; the source, syntax, installer
and Git diff checks above were used for the integration changes.
