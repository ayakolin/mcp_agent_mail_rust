#!/usr/bin/env bash
# Install/register the Agent Mail auto-wake client hooks (Codex native hooks,
# Claude Code hooks + channel MCP) from integrations/agent-mail-wake.
#
# Usage:
#   scripts/install_wake_hooks.sh [options]
#
# Options:
#   --clients LIST   Comma-separated clients (default: codex,claude)
#                    Recognized: omp,codex,claude,kimi,grok,opencode,all
#   --dry-run        Show the change plan without writing anything
#   --url URL        Agent Mail MCP endpoint (loopback HTTP only; installer default)
#   --prefix DIR     Runtime install dir (default: ~/.local/share/agent-mail/wake)
#   --bin-dir DIR    Launcher dir (default: ~/.local/bin)
#   -h|--help        Print this help
#
# Exit codes: 0 ok, 1 prerequisite/plan failure.
set -euo pipefail

CLIENTS="codex,claude"
DRY_RUN=0
EXTRA_ARGS=()

die() { printf '%s\n' "install_wake_hooks: $*" >&2; exit 1; }

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --clients) [ $# -ge 2 ] || die "--clients needs a value"; CLIENTS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --url) [ $# -ge 2 ] || die "--url needs a value"; EXTRA_ARGS+=(--url "$2"); shift 2 ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; EXTRA_ARGS+=(--prefix "$2"); shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a value"; EXTRA_ARGS+=(--bin-dir "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "not inside a git repository"
INTEGRATION_DIR="$REPO_ROOT/integrations/agent-mail-wake"
INSTALLER="$INTEGRATION_DIR/install.mjs"
[ -f "$INSTALLER" ] || die "installer not found: $INSTALLER"

# Resolve a Node.js >= 24 (the wake runtime requires built-ins from 24+).
find_node() {
  local candidates=()
  [ -n "${NODE_OVERRIDE:-}" ] && candidates+=("$NODE_OVERRIDE")
  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  local nvm_node
  for nvm_node in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$nvm_node" ] && candidates+=("$nvm_node")
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

[ "$CLIENTS" = "all" ] && CLIENTS="omp,codex,claude,kimi,grok,opencode"
ARGS=(--clients "$CLIENTS" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}")
[ "$DRY_RUN" = "1" ] && ARGS+=(--dry-run)

printf 'install_wake_hooks: %s install.mjs %s\n' "$NODE" "${ARGS[*]}" >&2
OUTPUT="$("$NODE" "$INSTALLER" "${ARGS[@]}")" || die "installer failed"
printf '%s\n' "$OUTPUT"

# Verify the managed hook blocks actually landed (or would land, for --dry-run).
verify() {
  local problems=0
  case ",$CLIENTS," in
    *,codex,*)
      local codex_dir="${CODEX_HOME:-$HOME/.codex}"
      grep -q 'agent-mail-wake managed hooks' "$codex_dir/config.toml" 2>/dev/null \
        || { printf 'verify: codex hook block MISSING in %s/config.toml\n' "$codex_dir" >&2; problems=1; }
      grep -q 'codex-hook.mjs' "$codex_dir/config.toml" 2>/dev/null \
        || { printf 'verify: codex-hook.mjs command MISSING in %s/config.toml\n' "$codex_dir" >&2; problems=1; }
      ;;
  esac
  case ",$CLIENTS," in
    *,claude,*)
      local claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
      jq -e '.hooks.SessionStart[].hooks[].command | select(contains("claude-channel.mjs"))' \
        "$claude_dir/settings.json" >/dev/null 2>&1 \
        || { printf 'verify: claude-channel hook MISSING in %s/settings.json\n' "$claude_dir" >&2; problems=1; }
      ;;
  esac
  return $problems
}

if [ "$DRY_RUN" = "1" ]; then
  printf 'install_wake_hooks: dry run complete (nothing written)\n' >&2
  exit 0
fi

verify || die "post-install verification failed"
printf 'install_wake_hooks: hooks registered and verified\n' >&2
cat >&2 <<'EOF'

Next steps:
  - Codex: trust the managed hooks once per install by running `codex` and
    invoking /hooks (automation may pass --dangerously-bypass-hook-trust).
  - Claude Code: restart sessions; the wake channel attaches on SessionStart.
  - Control: agent-mail-wake list | pause <id> | resume <id> | doctor
EOF
