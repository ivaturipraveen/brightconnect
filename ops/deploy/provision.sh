#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 host to run Brightworks.
# Run once, on the server:  sudo bash provision.sh
set -euo pipefail

APP_USER=brightworks
APP_DIR=/opt/brightworks

echo "==> Installing Node 24 and nginx"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y -qq nodejs

echo "==> Node $(node -v), npm $(npm -v)"

echo "==> Creating service user and directories"
id -u "$APP_USER" &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/workspaces"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing systemd unit"
install -m 644 "$(dirname "$0")/brightworks-api.service" /etc/systemd/system/brightworks-api.service
systemctl daemon-reload
systemctl enable brightworks-api

echo "==> Configuring nginx"
install -m 644 "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/brightworks
ln -sf /etc/nginx/sites-available/brightworks /etc/nginx/sites-enabled/brightworks
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

cat <<'DONE'

==> Provisioning complete.

Next:
  1. Create /opt/brightworks/.env with at minimum:

       ANTHROPIC_API_KEY=sk-ant-...
       GITHUB_TOKEN=github_pat_...
       GITHUB_OWNER=ivaturipraveen
       GITHUB_REPO=brightconnect
       NODE_ENV=production
       PORT=8787

     chown brightworks:brightworks /opt/brightworks/.env
     chmod 600 /opt/brightworks/.env

  2. Deploy from your laptop:  ./infra/deploy.sh <user>@<host>

DONE
