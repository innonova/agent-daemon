#!/usr/bin/env bash
# Builds the daemon, copies a production install to ~/.local/lib/agent-daemon,
# writes default profiles if none exist, and installs + starts the systemd
# user service. Re-running updates the install and restarts the service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AGENT_DAEMON_INSTALL_DIR:-$HOME/.local/lib/agent-daemon}"
CONFIG_DIR="${AGENT_DAEMON_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-daemon}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE="$(command -v node)"

echo "building in $ROOT"
(cd "$ROOT" && npm run build >/dev/null)

echo "installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/dist"
cp -r "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1)

mkdir -p "$CONFIG_DIR/profiles"
write_profile() {
  local f="$CONFIG_DIR/profiles/$1.json"
  if [ ! -e "$f" ]; then
    echo "writing default profile $f"
    printf '%s\n' "$2" > "$f"
  fi
}
write_profile claude '{
  "description": "Claude Code, headless stream-json",
  "command": "claude",
  "args": ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages"]
}'
write_profile codex '{
  "description": "Codex app-server (JSON-RPC over stdio)",
  "command": "codex",
  "args": ["app-server"]
}'
write_profile copilot '{
  "description": "GitHub Copilot CLI as an ACP server",
  "command": "copilot",
  "args": ["--acp"]
}'

mkdir -p "$UNIT_DIR"
# The service does not inherit the interactive shell's PATH, so bake in the
# one this script was run with (it must be able to find the agent CLIs).
sed -e "s#@NODE@#$NODE#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@PATH@#$PATH#g" \
  "$ROOT/systemd/agent-daemon.service" > "$UNIT_DIR/agent-daemon.service"
echo "installed unit $UNIT_DIR/agent-daemon.service"

# Keep the user manager (and this service) alive when no login session is open.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" && echo "enabled lingering for $USER" || echo "WARNING: could not enable lingering; the daemon will stop when you log out"
fi

systemctl --user daemon-reload
systemctl --user enable agent-daemon.service >/dev/null 2>&1 || true
if systemctl --user is-active --quiet agent-daemon.service; then
  echo "restarting agent-daemon (this ends any running sessions)"
  systemctl --user restart agent-daemon.service
else
  systemctl --user start agent-daemon.service
fi
sleep 1
systemctl --user --no-pager --lines=3 status agent-daemon.service || true
echo
echo "reload profiles with: systemctl --user reload agent-daemon"
echo "logs with:            journalctl --user -u agent-daemon -f"
