#!/usr/bin/env bash
# Deploy Brightworks to a provisioned host.
#   ./infra/deploy.sh ubuntu@1.2.3.4 [path/to/key.pem]
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host [key.pem]}"
KEY="${2:-}"
SSH_OPTS=()
[[ -n "$KEY" ]] && SSH_OPTS=(-i "$KEY")

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/brightworks

echo "==> Building the console"
( cd "$REPO_ROOT" && npm run build )

echo "==> Syncing to $TARGET"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  --exclude workspaces \
  --exclude .env \
  "$REPO_ROOT/" "$TARGET:/tmp/brightworks-deploy/"

echo "==> Installing on the host"
# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail
sudo rsync -a --delete \
  --exclude data --exclude workspaces --exclude .env \
  /tmp/brightworks-deploy/ $APP_DIR/
sudo chown -R brightworks:brightworks $APP_DIR
cd $APP_DIR
sudo -u brightworks npm ci --omit=dev --ignore-scripts 2>/dev/null || sudo -u brightworks npm install --omit=dev
sudo systemctl restart brightworks-api
sleep 2
sudo systemctl --no-pager --lines=15 status brightworks-api || true
REMOTE

echo "==> Verifying"
ssh "${SSH_OPTS[@]}" "$TARGET" 'curl -sf http://localhost:8787/api/health && echo " <- API healthy"'
echo "==> Done. Console: http://${TARGET#*@}/"
