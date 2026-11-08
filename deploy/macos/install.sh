#!/bin/bash
# Install (or reinstall) the MyCiTi server as a launchd agent on macOS, and optionally a
# Cloudflare quick tunnel next to it. Run from anywhere:
#
#   bash deploy/macos/install.sh            # server only
#   bash deploy/macos/install.sh --tunnel   # server + cloudflared quick tunnel
#   bash deploy/macos/install.sh --remove   # stop and remove both agents
#
# The agents start at login and are restarted if they exit. Logs: ~/Library/Logs/myciti/.
# Requires a finished `pnpm install && pnpm build` in the repository checkout.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/myciti"
SERVER_LABEL="za.myciti.server"
TUNNEL_LABEL="za.myciti.cloudflared"
UID_="$(id -u)"

bootout() {
  launchctl bootout "gui/$UID_/$1" 2>/dev/null || true
}

if [[ "${1:-}" == "--remove" ]]; then
  bootout "$SERVER_LABEL"
  bootout "$TUNNEL_LABEL"
  rm -f "$AGENTS/$SERVER_LABEL.plist" "$AGENTS/$TUNNEL_LABEL.plist"
  echo "removed"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found in PATH; install Node 22 from https://nodejs.org first" >&2; exit 1; }
[[ -f "$REPO/server/dist/index.js" ]] || { echo "server not built: run 'pnpm install && pnpm build' in $REPO" >&2; exit 1; }
[[ -f "$REPO/web/dist/index.html" ]] || echo "warning: web/dist not found, the server will serve the API only" >&2

mkdir -p "$AGENTS" "$LOGS"

# ---------------------------------------------------------------- server agent
render() {
  # $1 template, $2 destination
  sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__LOGS__|$LOGS|g" -e "s|__CLOUDFLARED__|${CLOUDFLARED:-}|g" "$1" > "$2"
}
bootout "$SERVER_LABEL"
render "$REPO/deploy/macos/$SERVER_LABEL.plist" "$AGENTS/$SERVER_LABEL.plist"
launchctl bootstrap "gui/$UID_" "$AGENTS/$SERVER_LABEL.plist"
echo "server agent installed: $AGENTS/$SERVER_LABEL.plist (log: $LOGS/server.log)"

# ---------------------------------------------------------------- tunnel agent
if [[ "${1:-}" == "--tunnel" ]]; then
  CLOUDFLARED="$(command -v cloudflared || true)"
  [[ -n "$CLOUDFLARED" ]] || { echo "cloudflared not found in PATH (see docs/macos-server.md)" >&2; exit 1; }
  bootout "$TUNNEL_LABEL"
  render "$REPO/deploy/macos/$TUNNEL_LABEL.plist" "$AGENTS/$TUNNEL_LABEL.plist"
  launchctl bootstrap "gui/$UID_" "$AGENTS/$TUNNEL_LABEL.plist"
  echo "tunnel agent installed: $AGENTS/$TUNNEL_LABEL.plist (log: $LOGS/cloudflared.log)"
  echo "the public URL appears in the log within a few seconds:"
  echo "  grep -o 'https://[a-z0-9-]*\\.trycloudflare\\.com' $LOGS/cloudflared.log | tail -1"
fi

echo
echo "check: curl -s http://127.0.0.1:3000/api/health | head -c 300"
