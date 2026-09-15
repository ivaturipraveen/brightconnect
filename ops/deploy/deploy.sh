#!/usr/bin/env bash
# Deploy to a provisioned host.
#   ./ops/deploy/deploy.sh ubuntu@1.2.3.4 key.pem
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host [key.pem]}"
KEY="${2:-}"
SSH=(ssh -o StrictHostKeyChecking=no)
[[ -n "$KEY" ]] && SSH+=(-i "$KEY")

# rsync parses -e with shell-like word splitting, so a key path containing a
# space has to be quoted inside the string - "${SSH[*]}" alone silently breaks
# it into separate arguments and rsync tries to connect to the second half.
RSH="ssh -o StrictHostKeyChecking=no"
[[ -n "$KEY" ]] && RSH="$RSH -i '$KEY'"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR=/opt/brightconnect

# A deploy restarts the dashboard, and a restart kills whatever the fleet is
# doing. Three ticket-to-PR runs were lost this way before anyone noticed - the
# mission just ends with "interrupted by a server restart", minutes of work and
# real money gone. Refuse by default; DEPLOY_FORCE=1 when you mean it.
echo "==> Checking for live missions"
LIVE="$(curl -fsS --max-time 10 "http://${TARGET#*@}/api/missions" 2>/dev/null \
  | tr ',' '\n' | grep -c '"status":"\(running\|queued\|awaiting_approval\)"' || true)"
if [[ "${LIVE:-0}" -gt 0 ]]; then
  if [[ "${DEPLOY_FORCE:-0}" == "1" ]]; then
    echo "    $LIVE mission(s) live - continuing because DEPLOY_FORCE=1"
  else
    echo "    REFUSING: $LIVE mission(s) are live and a deploy would kill them."
    echo "    Wait for them to finish, or re-run with DEPLOY_FORCE=1 to override."
    exit 1
  fi
else
  echo "    none running"
fi

echo "==> Building both consoles"
( cd "$ROOT" && npm run build )

echo "==> Syncing to $TARGET"
rsync -az --delete \
  -e "$RSH" \
  --exclude node_modules --exclude .git --exclude data --exclude workspaces \
  --exclude .env --exclude '*.log' \
  "$ROOT/" "$TARGET:/tmp/brightconnect-deploy/"

echo "==> Installing on the host"
"${SSH[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail
sudo rsync -a --delete \
  --exclude data --exclude workspaces --exclude .env \
  /tmp/brightconnect-deploy/ $APP_DIR/
sudo chown -R brightconnect:brightconnect $APP_DIR

# Production dependencies for each app that runs.
cd $APP_DIR                && sudo -u brightconnect npm install --omit=dev --no-audit --no-fund
cd $APP_DIR/product/backend && sudo -u brightconnect npm install --omit=dev --no-audit --no-fund

sudo systemctl restart brightconnect-dashboard brightconnect-chat
sleep 4
systemctl is-active brightconnect-dashboard >/dev/null && echo "    dashboard: active" || echo "    dashboard: FAILED"
systemctl is-active brightconnect-chat      >/dev/null && echo "    chat api : active" || echo "    chat api : FAILED"
REMOTE

echo "==> Verifying"
# Poll rather than check once: the dashboard opens a Postgres connection before
# it listens, so a single immediate check reports a false failure.
"${SSH[@]}" "$TARGET" '
  for svc in "dashboard:8787" "chat:8080"; do
    name="${svc%%:*}"; port="${svc##*:}"
    for i in $(seq 1 20); do
      if curl -sf "http://localhost:$port/api/health" >/dev/null 2>&1; then
        echo "    $name API healthy"; break
      fi
      [ "$i" = 20 ] && echo "    $name API NOT healthy after 20s"
      sleep 1
    done
  done
'
echo "==> Done. Dashboard: http://${TARGET#*@}/    Product: http://${TARGET#*@}/app/"
