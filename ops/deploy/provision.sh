#!/usr/bin/env bash
# Prepare a fresh Ubuntu host. Run once, on the server, as root:
#   sudo bash provision.sh
set -euo pipefail

APP_USER=brightconnect
APP_DIR=/opt/brightconnect

echo "==> Installing Node 24, nginx and tooling"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# bubblewrap and socat are what the agent sandbox is built on. Without them
# every mission fails instantly with "Sandbox required but unavailable" - the
# box serves the dashboard perfectly and cannot run a single agent.
apt-get install -y -qq curl ca-certificates gnupg rsync nginx git bubblewrap socat
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
apt-get install -y -qq nodejs
echo "    node $(node -v), npm $(npm -v)"

echo "==> Creating the service user and directories"
id -u "$APP_USER" &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"/{data,workspaces}
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing systemd units"
install -m 644 "$(dirname "$0")/brightconnect-dashboard.service" /etc/systemd/system/
install -m 644 "$(dirname "$0")/brightconnect-chat.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable brightconnect-dashboard brightconnect-chat >/dev/null

echo "==> Configuring nginx"
install -m 644 "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/brightconnect
ln -sf /etc/nginx/sites-available/brightconnect /etc/nginx/sites-enabled/brightconnect
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

cat <<'DONE'

==> Ready.

Next:
  1. Put secrets in /opt/brightconnect/.env  (ANTHROPIC_API_KEY at minimum)
     chown brightconnect:brightconnect /opt/brightconnect/.env && chmod 600 it
  2. Deploy from your laptop:  ./ops/deploy/deploy.sh <user>@<host> <key.pem>

DONE
