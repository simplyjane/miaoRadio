#!/usr/bin/env bash
# Pull latest code and restart the service. Run on the instance.
#
#   bash deploy/update.sh           # main branch
#   BRANCH=feature/foo bash deploy/update.sh

set -euo pipefail
BRANCH="${BRANCH:-main}"
cd "$HOME/miaoRadio"

git fetch origin
git checkout "$BRANCH"
git pull --ff-only

npm ci

sudo systemctl restart miaoradio
sleep 1
sudo systemctl status miaoradio --no-pager | head -10
echo
echo "Tail logs with:  journalctl -u miaoradio -f"
