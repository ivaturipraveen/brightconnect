#!/usr/bin/env bash
# Deploy to a provisioned host.
#   ./ops/deploy/deploy.sh ubuntu@1.2.3.4 key.pem
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host [key.pem]}"
KEY="${2:-}"
SSH=(ssh -o StrictHostKeyChecking=no)
[[ -n "$KEY" ]] && SSH+=(-i "$KEY")

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR=/opt/brightconnect

echo "==> Building both consoles"
( cd "$ROOT" && npm run build )

echo "==> Syncing to $TARGET"
rsync -az --delete \
  -e "${SSH[*]}" \
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
"${SSH[@]}" "$TARGET" '
  curl -sf http://localhost:8787/api/health >/dev/null && echo "    dashboard API healthy" || echo "    dashboard API NOT healthy"
  curl -sf http://localhost:8080/api/health >/dev/null && echo "    chat API healthy"      || echo "    chat API NOT healthy"
'
echo "==> Done. Dashboard: http://${TARGET#*@}/    Product: http://${TARGET#*@}/app/"
