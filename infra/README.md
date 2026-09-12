# Deploying Brightworks

Two steps: provision the box once, then deploy as often as you like.

## 1. Provision (once, on the server)

Ubuntu 24.04, t3.large or larger, 30 GB disk, ports 22/80/443 open.

```bash
scp -i key.pem -r infra ubuntu@<host>:/tmp/
ssh -i key.pem ubuntu@<host> 'sudo bash /tmp/infra/provision.sh'
```

Installs Node 24, nginx, a `brightworks` service user, the systemd unit, and the
reverse proxy.

## 2. Configure secrets (once, on the server)

```bash
ssh -i key.pem ubuntu@<host>
sudo tee /opt/brightworks/.env >/dev/null <<'ENV'
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=github_pat_...
GITHUB_OWNER=ivaturipraveen
GITHUB_REPO=brightconnect
NODE_ENV=production
PORT=8787
ENV
sudo chown brightworks:brightworks /opt/brightworks/.env
sudo chmod 600 /opt/brightworks/.env
```

The `.env` never leaves the server — `deploy.sh` explicitly excludes it, so a deploy
cannot overwrite your keys.

## 3. Deploy (from your laptop, any time)

```bash
./infra/deploy.sh ubuntu@<host> key.pem
```

Builds the console, syncs the repo, installs dependencies, restarts the service, and
verifies the health endpoint.

## Operating

```bash
sudo systemctl status brightworks-api      # is it up
sudo journalctl -u brightworks-api -f      # live logs
sudo systemctl restart brightworks-api     # restart
```

`Restart=always` means the service comes back on crash and after reboot.

## HTTPS

Once DNS points at the box:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d brightworks.yourdomain.com
```

Certbot rewrites the nginx config and sets up renewal. The SSE block's
`proxy_buffering off` is preserved — without it the live console appears to freeze.

## Notes

- **SSE through nginx** needs `proxy_buffering off` and a long `proxy_read_timeout`.
  Both are set in `nginx.conf`; keep them if you change it.
- **Data lives in** `/opt/brightworks/data` (SQLite) and `/opt/brightworks/workspaces`
  (agent scratch space). Both are excluded from deploys, so they survive.
- **Sizing**: t3.medium works for a single mission. Use t3.large if you plan to run
  concurrent missions in front of an audience.
