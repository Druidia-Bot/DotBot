# DotBot Server — Deployment Checklist

## Recommended Specs

| Users | Linode Plan | RAM | CPUs | Monthly |
|-------|-------------|-----|------|---------|
| < 1,000 | Linode 4GB | 4 GB | 2 | $24 |
| 1,000–5,000 | Linode 8GB | 8 GB | 4 | $48 |
| 5,000+ | 2× Linode 4GB + NodeBalancer | 4 GB each | 2 each | $58 |

> At 5,000+ concurrent WebSocket connections, consider horizontal scaling with a NodeBalancer
> and migrating SQLite → managed PostgreSQL.

---

## Pre-Deploy (on your local machine)

- [ ] **Domain DNS** — Point an A record (e.g. `dotbot.yourdomain.com`) to your Linode's IP
- [ ] **API keys ready** — At minimum one LLM key (DeepSeek, Anthropic, OpenAI, or Gemini)
- [ ] **Optional keys** — `SCRAPING_DOG_API_KEY` for premium tools
- [ ] **Git repo accessible** — Or plan to rsync the code
- [ ] **Tests pass locally** — `npm run test:server`

---

## Server Setup (one-time)

### 1. Create Linode

- [ ] Log into Linode → Create → **Linode**
- [ ] Image: **Ubuntu 24.04 LTS**
- [ ] Region: closest to your user base
- [ ] Plan: **Shared CPU — Linode 4GB** ($24/mo) to start
- [ ] Set root password, add your SSH key
- [ ] Create and note the IP address

### 2. DNS

- [ ] Add A record: `dotbot.yourdomain.com` → `<LINODE_IP>`
- [ ] Wait for propagation (check with `dig dotbot.yourdomain.com`)

### 3. SSH In & Run Setup

```bash
ssh root@<LINODE_IP>

# Upload deploy folder (from your local machine, separate terminal):
scp -r deploy/ root@<LINODE_IP>:/root/deploy/

# Or upload entire project:
rsync -avz --exclude node_modules --exclude .git --exclude dist \
  ./ root@<LINODE_IP>:/opt/dotbot/
```

Then on the server:

```bash
# Edit the script first — set your DOMAIN
nano /root/deploy/setup.sh

# Run it
chmod +x /root/deploy/setup.sh
./deploy/setup.sh
```

### 4. Configure .env

```bash
nano /opt/dotbot/.env
```

Set your real API keys. The file is `chmod 600` (only dotbot user can read).

### 5. Start & Verify

```bash
systemctl start dotbot
systemctl status dotbot          # Should show "active (running)"
journalctl -u dotbot -n 20      # Check startup logs

curl https://dotbot.yourdomain.com/
# Should return: {"service":"DotBot Server","version":"0.1.0","status":"running"}
```

### 6. Get Your Invite Token

On first start, the server auto-generates an invite token. Since it runs as a systemd service, check the logs:

```bash
journalctl -u dotbot -n 30 | grep -A3 "Invite Token"
```

Or generate one explicitly:
```bash
sudo -u dotbot node /opt/dotbot/server/dist/index.js --generate-invite --label "My PC"
```

Copy the token (`dbot-XXXX-XXXX-XXXX-XXXX`) — you'll give this to the client.

### 7. Connect a Local Agent (Windows)

On the user's Windows PC:

```powershell
# Clone and build
git clone https://github.com/Druidia-Bot/DotBot.git ~/DotBot
cd ~/DotBot
npm install
npm run build -w shared -w local-agent

# Configure connection
mkdir "$env:USERPROFILE\.bot" -Force
@"
DOTBOT_SERVER=wss://dotbot.yourdomain.com/ws
DOTBOT_INVITE_TOKEN=dbot-XXXX-XXXX-XXXX-XXXX
"@ | Set-Content "$env:USERPROFILE\.bot\.env"

# Start the agent
node local-agent/dist/index.js
```

On first connect, the agent registers with the server using the invite token, receives permanent device credentials (`~/.bot/device.json`), and removes the consumed token from `.env` automatically.

---

## Post-Deploy Verification

- [ ] `curl https://yourdomain.com/` returns health JSON
- [ ] WebSocket connects: local agent logs "Authenticated successfully!"
- [ ] Invite token consumed: agent logs "Removed consumed invite token from .env"
- [ ] Send a test prompt through the client
- [ ] Check server logs: `journalctl -u dotbot -f`
- [ ] Caddy HTTPS works (check browser padlock)
- [ ] Firewall blocks direct port access: `curl http://<IP>:3000` should timeout

---

## Updating the Server

After pushing new code:

```bash
ssh root@<LINODE_IP>

# Option A: If using git
cd /opt/dotbot && git pull

# Option B: If rsyncing
# (from local machine)
rsync -avz --exclude node_modules --exclude .git --exclude dist \
  --exclude .env --exclude "*.db" \
  ./ root@<LINODE_IP>:/opt/dotbot/

# Then on server:
chmod +x /opt/dotbot/deploy/update.sh
/opt/dotbot/deploy/update.sh
```

---

## Monitoring & Operations

### Logs

```bash
journalctl -u dotbot -f              # Live server logs
journalctl -u dotbot --since "1h ago" # Last hour
journalctl -u caddy -f               # Caddy access logs
tail -f /var/log/caddy/dotbot-access.log
```

### Service Management

```bash
systemctl status dotbot     # Status
systemctl restart dotbot    # Restart
systemctl stop dotbot       # Stop
systemctl enable dotbot     # Auto-start on boot (already done by setup.sh)
```

### Resource Monitoring

```bash
htop                                # CPU/RAM overview
ss -tlnp | grep -E '3000|3001'     # Verify ports are listening
ss -s                               # Socket summary (connection count)
du -sh /home/dotbot/.bot/           # Data directory size
```

### Database

```bash
# SQLite DB location
ls -la /home/dotbot/.bot/server-data/dotbot.db

# Quick query (install sqlite3 first: apt install sqlite3)
sqlite3 /home/dotbot/.bot/server-data/dotbot.db ".tables"
sqlite3 /home/dotbot/.bot/server-data/dotbot.db "SELECT count(*) FROM user_credits;"
```

---

## Scaling Checklist (when you outgrow one server)

- [ ] **Symptom**: Memory > 80%, connection errors, slow responses
- [ ] **Step 1**: Upgrade Linode plan (vertical scale — zero downtime resize)
- [ ] **Step 2**: If still not enough, add a second Linode:
  - [ ] Migrate SQLite → managed PostgreSQL (Linode Managed DB or external)
  - [ ] Set up NodeBalancer ($10/mo) with sticky sessions (WebSocket affinity)
  - [ ] Deploy identical server on both Linodes behind the NodeBalancer
  - [ ] Point DNS to NodeBalancer IP instead of individual Linode
  - [ ] Update Caddy to listen only on localhost (NodeBalancer handles SSL)

---

## Security Hardening (recommended)

- [ ] **SSH key only** — Disable password auth: `PasswordAuthentication no` in `/etc/ssh/sshd_config`
- [ ] **Fail2ban** — `apt install fail2ban` (blocks brute force SSH)
- [ ] **Unattended upgrades** — `apt install unattended-upgrades` (auto security patches)
- [ ] **Backup .env** — Store API keys in a password manager, not only on the server
- [ ] **Backup SQLite** — Cron job to copy `dotbot.db` to object storage weekly:
  ```bash
  # /etc/cron.weekly/dotbot-backup
  #!/bin/bash
  cp /home/dotbot/.bot/server-data/dotbot.db /home/dotbot/.bot/server-data/dotbot.db.bak
  ```

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| Server won't start | `journalctl -u dotbot -n 50` — look for missing API key or port conflict |
| WebSocket won't connect | Verify Caddy is proxying `/ws` → `:3001`, check `journalctl -u caddy` |
| HTTPS not working | DNS not propagated yet, or Caddy can't reach Let's Encrypt (check port 80/443 open) |
| "No local-agent connected" | Agent not connected, check agent-side `DOTBOT_SERVER` URL uses `wss://` |
| High memory usage | Check connection count with `ss -s`, consider upgrading plan |
| SQLite locked errors | Too many concurrent writes — time to migrate to PostgreSQL |
| `better-sqlite3` build fails | Missing build tools: `apt install build-essential python3` |
