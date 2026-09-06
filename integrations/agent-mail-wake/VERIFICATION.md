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


## Grok Build wake adapter (added locally, 2026-09-07)

The Grok adapter (managed `grok agent stdio` ACP session) was verified on this
machine against Grok Build 1.0.3 / Agent Mail 0.3.32 / Node.js 24.3.0:

- ACP `initialize` → `session/new` (`_meta.rules` carrying mailbox identity) →
  `session/prompt` round trip: model echoed the requested marker.
- Live loop: `grok-mail` listener registered a mailbox; incoming mail woke the
  session; the woken model fetched its inbox, acknowledged the contact request,
  and replied through the `mcp_agent_mail` tools (reply archived as message #7
  in the thread).
- Caveat found during verification: with the local BYOK proxy's `responses`
  backend the tool loop aborts after the first response
  (`missing field output_tokens_details` in `response.completed`); the
  `chat_completions` backend completes the loop.

## OpenCode wake adapter (added locally, 2026-09-07)

Verified on this machine against OpenCode 1.18.21 / Agent Mail 0.3.32:
`opencode-mail` started `opencode serve`, created a session, woke on incoming
mail, and the woken agent fetched its inbox and replied through the
`mcp_agent_mail` tools (reply archived as `Re: oc wake` containing the agreed
marker). `POST /session/:id/message` blocks until the turn completes, so no SSE
event stream is required by the adapter.

## Codex mid-turn steer delivery (2026-09-07)

The Codex adapter previously refused delivery while a turn was active, so mail
waited for the whole turn. It now injects into the running turn via the App
Server's `turn/steer`. Verified live against Codex 0.153.4
(`codex app-server --listen ws://127.0.0.1:PORT`, `experimentalApi` negotiated):

- `turn/steer` on an active turn with the correct `expectedTurnId` is accepted
  (`{"turnId": ...}`); the steered text materializes as a `userMessage` inside
  the same turn and the model reacts to it within that turn (observed markers:
  `STEERED-OK`, `MID-TURN-SEEN`, `VIA-START`).
- `turn/steer` on an idle thread fails with `no active turn to steer`; a stale
  `expectedTurnId` fails with a mismatch naming the currently active turn. The
  adapter re-reads once on steer failure and falls back to `turn/start` when the
  thread went idle.
- `clientUserMessageId` is persisted on the materialized item (`clientId`) but
  is NOT deduplicated server-side: a duplicate steer lands twice. Delivery
  remains at-least-once; the durable pending batch plus the
  `[Agent Mail delivery <id>]` marker reconcile watcher restarts.
- End to end: with a long essay turn running, mail sent to the watcher's
  mailbox was steered into the active turn ~0.6 s after `send_message`
  (poll interval 1 s in the probe), inside the same turn; the delivery cursor
  advanced only after the steer was accepted.

`thread/read` on an active thread does not expose a steered message in `turns`
until the model consumes it, so a steer accepted immediately before a watcher
crash can be re-steered once on restart; the batch prompt instructs the model
to process each message once.

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
