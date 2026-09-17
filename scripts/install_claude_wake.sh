#!/usr/bin/env bash
# Install the Agent Mail auto-wake integration for Claude Code.
#
# Claude auto-wake is three surfaces; this script installs and verifies all of
# them:
#   1. hooks    — PreToolUse / SessionStart / PostToolUse / Stop / SessionEnd in
#                 ~/.claude/settings.json. Stop carries asyncRewake so fresh
#                 mail reopens an idle session; PostToolUse steers mail into an
#                 active turn at tool boundaries; PreToolUse blocks duplicate
#                 mailbox registration.
#   2. mcp      — the mcp_agent_mail connection plus the agent_mail_wake
#                 channel in ~/.claude.json (plain `claude` needs the native
#                 flag --channel=server:agent_mail_wake, or use claude-mail).
#   3. runtime  — launcher ~/.local/bin/claude-mail and the wake code copied
#                 to ~/.local/share/agent-mail/wake.
#
# The merge logic itself lives in integrations/agent-mail-wake/install.mjs
# --clients claude and is the single source of truth: it backs up every file
# before rewriting it, preserves existing mcpServers entries and credentials,
# and is idempotent. This script adds the Claude-specific preflight, the
# full-surface verification install.mjs does not do, an optional
# `agent-mail-wake doctor` pass, and an isolated end-to-end wake smoke test.
#
# Usage:
#   scripts/install_claude_wake.sh [options]
#
# Options:
#   --dry-run         Show the file plan only (delegates to install.mjs)
#   --verify-only     Verify the current install; write nothing
#   --url URL         Agent Mail MCP endpoint (loopback HTTP only)
#   --home DIR        Target HOME for configs + runtime (isolated runs)
#   --prefix DIR      Runtime install directory
#   --bin-dir DIR     Launcher directory
#   --no-verify       Skip post-install verification
#   --with-doctor     Run `agent-mail-wake doctor` after install
#   --smoke-test      End-to-end: isolated install, register a throwaway
#                     mailbox through the real hooks, deliver one message,
#                     drain it via PostToolUse, then discard the scratch tree
#   -h|--help         Print this help
#
# Exit codes: 0 success, 1 prerequisite/verification/install failure.
set -euo pipefail

CLIENT="claude"
DRY_RUN=0
VERIFY_ONLY=0
DO_VERIFY=1
WITH_DOCTOR=0
SMOKE=0
EXTRA_ARGS=()

die() { printf '%s\n' "install_claude_wake: $*" >&2; exit 1; }
note() { printf '%s\n' "install_claude_wake: $*" >&2; }

usage() { sed -n '2,41p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --url) [ $# -ge 2 ] || die "--url needs a value"; EXTRA_ARGS+=(--url "$2"); shift 2 ;;
    --home) [ $# -ge 2 ] || die "--home needs a value"; EXTRA_ARGS+=(--home "$2"); shift 2 ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; EXTRA_ARGS+=(--prefix "$2"); shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a value"; EXTRA_ARGS+=(--bin-dir "$2"); shift 2 ;;
    --no-verify) DO_VERIFY=0; shift ;;
    --with-doctor) WITH_DOCTOR=1; shift ;;
    --smoke-test) SMOKE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [ "$DRY_RUN" = "1" ] && [ "$VERIFY_ONLY" = "1" ]; then
  die "--dry-run and --verify-only are mutually exclusive"
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "not inside a git repository"
INSTALLER="$REPO_ROOT/integrations/agent-mail-wake/install.mjs"
[ -f "$INSTALLER" ] || die "installer not found: $INSTALLER"

# Resolve Node.js >= 24 (the wake runtime uses 24+ built-ins).
find_node() {
  local candidates=()
  if [ -n "${NODE_OVERRIDE:-}" ]; then candidates+=("$NODE_OVERRIDE"); fi
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  local n
  for n in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$n" ] && candidates+=("$n")
  done
  local c
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
      printf '%s\n' "$c"; return 0
    fi
  done
  return 1
}
NODE="$(find_node)" || die "Node.js 24+ is required (set NODE_OVERRIDE=/path/to/node to force one)"

# EXTRA_ARGS holds only `--flag value` pairs in declaration order.
flag_value() { # flag -> value if present in EXTRA_ARGS, else exit 1
  local flag="$1" i
  for ((i = 0; i + 1 < ${#EXTRA_ARGS[@]}; i += 2)); do
    if [ "${EXTRA_ARGS[$i]}" = "$flag" ]; then
      printf '%s\n' "${EXTRA_ARGS[$((i + 1))]}"; return 0
    fi
  done
  return 1
}

# Mirror install.mjs path resolution: --home wins over the environment,
# CLAUDE_CONFIG_DIR / XDG_DATA_HOME honored only for the real home.
override_home="$(flag_value --home || true)"
HOME_DIR="${override_home:-$HOME}"
URL="$(flag_value --url || true)"; URL="${URL:-http://127.0.0.1:8765/mcp/}"
CLAUDE_DIR="$HOME_DIR/.claude"
CLAUDE_JSON="$HOME_DIR/.claude.json"
if [ -z "$override_home" ]; then
  CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$CLAUDE_DIR}"
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then CLAUDE_JSON="$CLAUDE_DIR/.claude.json"; fi
fi
override_prefix="$(flag_value --prefix || true)"
override_bindir="$(flag_value --bin-dir || true)"
PREFIX=""
if [ -z "$override_home" ] && [ -z "$override_prefix" ] && [ -n "${XDG_DATA_HOME:-}" ]; then
  PREFIX="$XDG_DATA_HOME/agent-mail/wake"
fi
PREFIX="${override_prefix:-${PREFIX:-$HOME_DIR/.local/share/agent-mail/wake}}"
BIN_DIR="${override_bindir:-$HOME_DIR/.local/bin}"
SETTINGS="$CLAUDE_DIR/settings.json"

# Bearer discovery mirrors install.mjs discoverToken() + common.mjs bearerToken().
resolve_token() {
  if [ -n "${AGENT_MAIL_BEARER_TOKEN:-}" ]; then printf '%s\n' "$AGENT_MAIL_BEARER_TOKEN"; return; fi
  local file
  if [ -n "$override_home" ]; then
    file="$HOME_DIR/.config/mcp-agent-mail/config.env"
  else
    file="${AGENT_MAIL_CONFIG_ENV:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/mcp-agent-mail/config.env}"
  fi
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?HTTP_BEARER_TOKEN[[:space:]]*=[[:space:]]*"?([^"[:space:]]*)"?.*$/\2/p' "$file" 2>/dev/null | head -1
}

# ---------------------------- 1. preflight -----------------------------------
preflight() {
  local missing=0
  if ! command -v jq >/dev/null 2>&1; then
    note "preflight: jq not found (needed to verify $SETTINGS)"; missing=1
  fi
  [ -d "$CLAUDE_DIR" ] || note "preflight: no Claude config dir at $CLAUDE_DIR; the installer will create it (install/log in to Claude Code for a usable session)"
  command -v claude >/dev/null 2>&1 || note "preflight: claude binary not on PATH (hooks install fine; you need Claude Code to use them)"
  local token status=""
  token="$(resolve_token || true)"
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$URL" \
      -H 'content-type: application/json' ${token:+-H "Authorization: Bearer $token"} \
      --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null || true)"
    case "$status" in
      200) note "preflight: Agent Mail reachable at $URL (authorized)" ;;
      401 | 403)
        if [ -z "$token" ]; then
          note "preflight: Agent Mail at $URL needs a bearer token but none was found — hooks will attach yet delivery will fail auth. Set AGENT_MAIL_BEARER_TOKEN or configure ~/.config/mcp-agent-mail/config.env."
        else
          note "preflight: Agent Mail rejected the discovered token at $URL — hooks will fail auth until it matches the server."
        fi ;;
      000 | "") note "preflight: Agent Mail NOT reachable at $URL — start it (am service install | am serve-http). Install proceeds; wake needs the server." ;;
      *) note "preflight: Agent Mail probe at $URL returned HTTP $status" ;;
    esac
  fi
  return $missing
}

# ---------------------------- 2. verification --------------------------------
# Every artifact install.mjs writes for --clients claude, checked independently.
verify_claude() {
  command -v jq >/dev/null 2>&1 || die "verification needs jq"
  local problems=0
  check() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
      note "ok   $desc"
    else
      note "FAIL $desc"; problems=1
    fi
  }
  for ev in PreToolUse SessionStart PostToolUse Stop SessionEnd; do
    check "hook $ev -> claude-channel.mjs" \
      jq -e --arg ev "$ev" '.hooks[$ev][]?.hooks[]? | select(.command? | contains("claude-channel.mjs"))' "$SETTINGS"
  done
  check "Stop hook has asyncRewake (idle-session wake)" \
    jq -e '.hooks.Stop[]?.hooks[]? | select(.command? | contains("claude-channel.mjs")) | select(.asyncRewake == true)' "$SETTINGS"
  check "channel agent_mail_wake -> $PREFIX/claude-channel.mjs" \
    jq -e --arg f "$PREFIX/claude-channel.mjs" '.mcpServers.agent_mail_wake.args[] | select(. == $f)' "$CLAUDE_JSON"
  check "MCP connection mcp_agent_mail -> $URL" \
    jq -e --arg u "$URL" '.mcpServers.mcp_agent_mail | select((.url // "") == $u)' "$CLAUDE_JSON"
  check "launcher $BIN_DIR/claude-mail" test -x "$BIN_DIR/claude-mail"
  check "runtime $PREFIX/claude-channel.mjs" test -f "$PREFIX/claude-channel.mjs"
  check "runtime $PREFIX/common.mjs" test -f "$PREFIX/common.mjs"
  return $problems
}

# ---------------------------- 3. smoke test ----------------------------------
# End-to-end against the live Agent Mail with an isolated AGENT_MAIL_WAKE_HOME
# so the real configs and state are never touched. SessionStart registers a
# throwaway receiver mailbox via the freshly installed runtime; a second
# throwaway sender delivers one message (collectMailboxBatch echo-filters mail
# from the mailbox's own agent, so sender != receiver is required); the
# PostToolUse hook must then surface it — the exact path auto-wake takes
# inside a Claude session. The scratch tree is deleted on exit; the throwaway
# mailboxes stay registered (retire needs their tokens) and are reported.
smoke_test() {
  command -v jq >/dev/null 2>&1 || die "smoke-test needs jq"
  # The EXIT trap fires after this function returns, when `local` vars are out
  # of scope — cleanup state must live in globals.
  SMOKE_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/claude-wake-smoke.XXXXXX")"
  SMOKE_AGENT=""
  SMOKE_SENDER=""
  local scratch="$SMOKE_SCRATCH"
  local wake_home="$scratch/.local/share/agent-mail/wake"
  local runtime="$wake_home/claude-channel.mjs"
  local session="smoke-$$-$RANDOM" mail_id=""
  cleanup() {
    if [ -n "${SMOKE_AGENT:-}" ]; then
      note "smoke: throwaway mailboxes '${SMOKE_SENDER:-?}' -> '${SMOKE_AGENT:-?}' stay registered (retire needs their tokens); 'am agents reap' or retire manually"
    fi
    [ -n "${SMOKE_SCRATCH:-}" ] && rm -rf -- "$SMOKE_SCRATCH"
    return 0
  }
  trap cleanup EXIT
  note "smoke: isolated install into $scratch"
  "$NODE" "$INSTALLER" --clients "$CLIENT" --home "$scratch" >/dev/null || die "smoke: isolated install failed"
  [ -f "$runtime" ] || die "smoke: runtime missing in scratch tree"
  note "smoke: SessionStart hook (session $session)"
  printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"startup","cwd":"%s"}' "$session" "$REPO_ROOT" \
    | env AGENT_MAIL_WAKE_HOME="$wake_home" AGENT_MAIL_URL="$URL" \
        "$NODE" "$runtime" hook >/dev/null || die "smoke: SessionStart hook failed"
  SMOKE_AGENT="$(cat "$wake_home"/state/*.json 2>/dev/null \
    | jq -r --arg s "$session" 'select(.host == "claude-code" and .session == $s) | .agent' | head -1)"
  [ -n "$SMOKE_AGENT" ] || die "smoke: hook registered no mailbox"
  note "smoke: mailbox $SMOKE_AGENT registered by the hook itself"
  mail_id="$(env AGENT_MAIL_WAKE_HOME="$wake_home" AGENT_MAIL_URL="$URL" \
      SMOKE_PROJECT="$REPO_ROOT" SMOKE_RECEIVER="$SMOKE_AGENT" SMOKE_TAG="$$-$RANDOM" \
      "$NODE" --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const { MailClient } = await import(pathToFileURL(process.env.AGENT_MAIL_WAKE_HOME + "/common.mjs").href);
    const client = new MailClient();
    // Echo suppression means the receiver cannot be its own sender.
    const created = await client.call("create_agent_identity", {
      project_key: process.env.SMOKE_PROJECT, program: "wake-smoke-sender",
      model: "none", task_description: "install_claude_wake smoke sender",
    });
    const r = await client.call("send_message", {
      project_key: process.env.SMOKE_PROJECT, from: created?.name,
      to: [process.env.SMOKE_RECEIVER], subject: `wake-smoke-${process.env.SMOKE_TAG}`,
      body_md: "smoke delivery", importance: "normal",
    });
    const id = r?.deliveries?.[0]?.payload?.id ?? r?.id;
    if (id === undefined) { console.error("unexpected send shape: " + JSON.stringify(r).slice(0, 300)); process.exit(1); }
    console.log(created?.name + " " + id);
  ')" || die "smoke: could not deliver the test message (is Agent Mail up + authorized?)"
  SMOKE_SENDER="${mail_id%% *}"; mail_id="${mail_id##* }"
  [ -n "$mail_id" ] || die "smoke: no message id returned"
  note "smoke: message $mail_id delivered; draining through PostToolUse hook"
  local out="" i
  for ((i = 0; i < 6; i++)); do
    out="$(printf '{"hook_event_name":"PostToolUse","session_id":"%s","tool_name":"Bash"}' "$session" \
      | env AGENT_MAIL_WAKE_HOME="$wake_home" AGENT_MAIL_URL="$URL" \
          "$NODE" "$runtime" hook 2>/dev/null || true)"
    if printf '%s' "$out" | grep -q "$mail_id"; then break; fi
    sleep 1
  done
  if ! printf '%s' "$out" | grep -q "$mail_id"; then
    die "smoke: hook never surfaced $mail_id (last output: ${out:0:200})"
  fi
  note "ok   wake smoke: mail $mail_id surfaced into the fake session via PostToolUse"
}

# ---------------------------- main -------------------------------------------
ARGS=(--clients "$CLIENT")
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then ARGS+=("${EXTRA_ARGS[@]}"); fi

if [ "$VERIFY_ONLY" = "1" ]; then
  preflight || true
  verify_claude || die "verification FAILED (run without --verify-only to (re)install)"
  note "all Claude wake surfaces present"
  exit 0
fi

preflight || die "preflight failed (missing prerequisite above)"

if [ "$DRY_RUN" = "1" ]; then
  note "plan (no writes):"
  exec "$NODE" "$INSTALLER" "${ARGS[@]}" --dry-run
fi

note "$NODE $INSTALLER ${ARGS[*]}"
OUTPUT="$("$NODE" "$INSTALLER" "${ARGS[@]}")" || die "installer failed"
printf '%s\n' "$OUTPUT"

if [ "$DO_VERIFY" = "1" ]; then
  verify_claude || die "post-install verification FAILED (backups: $PREFIX/backups/)"
  note "Claude wake surfaces verified: hooks + channel + launcher + runtime"
fi

if [ "$WITH_DOCTOR" = "1" ]; then
  note "agent-mail-wake doctor:"
  "$BIN_DIR/agent-mail-wake" doctor || die "wake doctor failed"
fi

if [ "$SMOKE" = "1" ]; then
  smoke_test
fi

cat >&2 <<EOF

Next steps:
  - Restart Claude Code sessions: SessionStart attaches the mailbox;
    PreToolUse/PostToolUse steer mail into the turn and Stop's asyncRewake
    reopens idle sessions on new mail.
  - Managed/headless: \`claude-mail\` (native flags after --).
  - Control: \`agent-mail-wake list | pause <id> | resume <id> | doctor\`
  - Backups of rewritten configs: $PREFIX/backups/
EOF
