#!/usr/bin/env bash
# One-shot setup for miaoRadio on a fresh Lightsail Ubuntu instance.
# Run as the `ubuntu` user after `ssh ubuntu@<your-static-ip>`.
#
#   bash <(curl -sL https://raw.githubusercontent.com/simplyjane/miaoRadio/main/deploy/install.sh)
#
# OR, if the repo is already cloned:
#   bash deploy/install.sh

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/simplyjane/miaoRadio.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="$HOME/miaoRadio"

echo "==> Updating apt and installing base packages"
sudo apt update
sudo apt install -y curl git ca-certificates build-essential debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Node 20 from NodeSource"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node --version
npm --version

echo "==> Installing Caddy from its official repo"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
fi
caddy version

echo "==> Cloning miaoRadio"
if [ ! -d "$APP_DIR" ]; then
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only

echo "==> Installing app dependencies"
npm ci

echo "==> Installing Caddyfile"
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

echo "==> Installing systemd unit"
sudo cp deploy/miaoradio.service /etc/systemd/system/miaoradio.service
sudo systemctl daemon-reload
sudo systemctl enable miaoradio

echo "==> Setting server timezone to America/Montreal"
sudo timedatectl set-timezone America/Montreal

cat <<EOF

──────────────────────────────────────────────────────────────────────
Install complete. Next steps (do these manually):

1. Create your .env file:
     cp deploy/.env.example .env
     nano .env                    # fill in every blank
     chmod 600 .env

2. Open Lightsail firewall ports 80 and 443 in the AWS Console:
     Instance → Networking → IPv4 Firewall → Add rule (HTTP, HTTPS)

3. Point DNS:
     miaoradio.pilipalajing.com  A  $(curl -s ifconfig.me 2>/dev/null || echo "<your-static-IP>")

4. Add these redirect URIs to your Google OAuth client
   (https://console.cloud.google.com/apis/credentials):
     https://miaoradio.pilipalajing.com/api/auth/callback
     https://miaoradio.pilipalajing.com/api/me/calendar/callback

5. Start the radio:
     sudo systemctl start miaoradio
     sudo systemctl status miaoradio
     journalctl -u miaoradio -f       # live logs

6. Verify in a browser:
     https://miaoradio.pilipalajing.com
──────────────────────────────────────────────────────────────────────
EOF
