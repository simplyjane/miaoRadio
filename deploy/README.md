# Deploying miaoRadio to AWS Lightsail

Target setup:
- **Lightsail Micro** ($5/mo, 1 GB RAM, 40 GB SSD, 2 TB transfer)
- Ubuntu 22.04 or 24.04 LTS
- Static IP (free, attached to the instance)
- Domain: `miaoradio.pilipalajing.com`
- Caddy reverse proxy with auto-Let's-Encrypt TLS
- Node 20 + systemd-managed service

End result: `https://miaoradio.pilipalajing.com` serves the PWA, Google sign-in works, the SQLite DB lives at `/home/ubuntu/miaoRadio/state.db`.

---

## 1. Provision the instance (Lightsail console)

1. Sign in at <https://lightsail.aws.amazon.com>.
2. **Create instance** → Linux/Unix → **OS Only** → **Ubuntu 24.04 LTS**.
3. Instance plan: **$5/mo** (1 GB, 2 vCPU, 40 GB SSD).
4. Name it `miaoradio`. Create.
5. After it's running, open the instance → **Networking** tab → **Create static IP**, attach it. Note the IP.
6. Same **Networking** tab → **IPv4 Firewall** → add rules:
   - HTTP (TCP 80) — needed for Let's Encrypt's HTTP-01 challenge
   - HTTPS (TCP 443) — the actual traffic
   - (SSH/22 is already open by default)

## 2. Point DNS

At the DNS provider for `pilipalajing.com`, add an **A record**:

```
Name:  miaoradio
Type:  A
Value: <your static IP>
TTL:   default
```

Wait ~1–5 minutes, then verify from your laptop:

```bash
dig +short miaoradio.pilipalajing.com
# should print your static IP
```

## 3. SSH in and run the installer

Lightsail console → instance → **Connect using SSH** (browser) — or download the SSH key from the **Account → SSH keys** page and `ssh ubuntu@<static-ip>`.

Once on the instance:

```bash
bash <(curl -sL https://raw.githubusercontent.com/simplyjane/miaoRadio/main/deploy/install.sh)
```

What this does:
- Installs Node 20, build-essential, Caddy.
- Clones the repo into `~/miaoRadio`.
- Runs `npm ci`.
- Copies the Caddyfile to `/etc/caddy/Caddyfile` and reloads Caddy (which immediately starts trying to issue your cert).
- Copies the systemd unit, enables (but does not yet start) the service.
- Sets the server timezone to `America/Montreal`.

## 4. Create `.env`

```bash
cd ~/miaoRadio
cp deploy/.env.example .env
nano .env
```

Fill in every blank. The required ones for the radio to work at all are:

- `ANTHROPIC_API_KEY`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET` — generate with `openssl rand -hex 32`
- `INVITE_CODES` — anything you want, comma-separated, e.g. `4E5F6A7B8C,DEAD-BEEF`

Then:

```bash
chmod 600 .env
```

## 5. Update Google OAuth redirect URIs

In <https://console.cloud.google.com/apis/credentials>, open your OAuth 2.0 Client and add these to **Authorized redirect URIs**:

```
https://miaoradio.pilipalajing.com/api/auth/callback
https://miaoradio.pilipalajing.com/api/me/calendar/callback
```

(Keep the localhost ones if you want to keep developing locally; they don't conflict.)

## 6. Start the service

```bash
sudo systemctl start miaoradio
sudo systemctl status miaoradio   # should say "active (running)"
journalctl -u miaoradio -f        # live logs; Ctrl-C to exit
```

## 7. Verify

Visit `https://miaoradio.pilipalajing.com` in your browser.
- The cert should be valid (Caddy issues it on first request — first hit may be slow).
- The PWA should load, default to English (or French if your browser locale is French).
- Click **SIGN UP**, enter an invite code, sign in with Google.
- After signing in, open **SETTINGS** — your corpus should show up if you set `ADMIN_EMAIL` (or you can just paste it manually).

---

## Updating

After the auto-deploy is set up (next section), **every push to `main` deploys automatically** — no SSH needed. The workflow lives at `.github/workflows/deploy.yml`.

If you ever need to deploy manually (e.g. before auto-deploy is wired up, or to redeploy without pushing a new commit), SSH in and:

```bash
bash ~/miaoRadio/deploy/update.sh
```

Or trigger the workflow manually from the GitHub Actions tab → **Deploy to prod** → **Run workflow**.

## Auto-deploy on push to main (one-time setup)

Set this up once, after the instance is provisioned and the first manual deploy works.

### 1. Generate a deploy key on your laptop

```bash
ssh-keygen -t ed25519 -f ~/.ssh/miaoradio_deploy -N "" -C "github-actions-miaoradio"
```

This creates `~/.ssh/miaoradio_deploy` (private) and `~/.ssh/miaoradio_deploy.pub` (public).

### 2. Authorize the public key on the Lightsail instance

```bash
cat ~/.ssh/miaoradio_deploy.pub | ssh ubuntu@<static-ip> \
  'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

Verify:

```bash
ssh -i ~/.ssh/miaoradio_deploy ubuntu@<static-ip> 'echo ok'
# → ok
```

### 3. Add GitHub repo secrets

In <https://github.com/simplyjane/miaoRadio/settings/secrets/actions>, add two repository secrets:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | The full contents of `~/.ssh/miaoradio_deploy` (the private key, including the `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----END OPENSSH PRIVATE KEY-----` lines) |
| `DEPLOY_HOST` | Your Lightsail static IP, e.g. `18.234.56.78` |

### 4. Test it

Make any small change (e.g. tweak a comment), commit, push to `main`. Watch:

<https://github.com/simplyjane/miaoRadio/actions>

The job should:
1. Configure SSH from the secrets.
2. SSH into the instance.
3. Run `~/miaoRadio/deploy/update.sh` (git pull + npm ci + systemctl restart).
4. Verify the service is active.

Total runtime: ~30 seconds for a typical no-deps change.

### Rolling back

If a deploy goes sideways, SSH in and revert:

```bash
cd ~/miaoRadio
git log --oneline -5            # find the last-good commit
git reset --hard <sha>
npm ci
sudo systemctl restart miaoradio
```

Then revert the bad commit on GitHub so the next push doesn't re-deploy it.

## Backing up the DB

Lightsail has automatic snapshots (Instance → Snapshots → Enable automatic snapshots) — covers the whole disk including `state.db`. For an explicit DB-only backup to your laptop:

```bash
scp ubuntu@<static-ip>:~/miaoRadio/state.db ./state-$(date +%F).db
```

SQLite supports online backup; this is safe to do while the service is running because WAL mode handles concurrent readers.

## Logs and troubleshooting

| Symptom | Where to look |
|---|---|
| Service won't start | `journalctl -u miaoradio -n 100 --no-pager` |
| HTTPS not working | `journalctl -u caddy -n 100 --no-pager` |
| Cert issuance failing | Check DNS resolves; check port 80 is open in Lightsail firewall |
| OAuth redirect mismatch | Verify the exact URL in Google Cloud Console matches `PUBLIC_URL` in `.env` |
| 500 from `/api/chat` | Tail `journalctl -u miaoradio -f` while reproducing; usually a missing env var |
