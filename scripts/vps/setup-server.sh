#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VPS for TMS (docs/06-trien-khai-vps.md).
# Run as root:  bash setup-server.sh '<ssh public key>'
# Creates user `deploy` (sudo, docker) that logs in with the given key, adds 4 GB swap,
# installs Docker, opens only SSH in UFW, then turns off SSH password and root login.
set -euo pipefail

PUBKEY="${1:?usage: setup-server.sh '<ssh public key>'}"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git ufw fail2ban

# User deploy, key-only login.
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' deploy
fi
usermod -aG sudo deploy
echo 'deploy ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-deploy
chmod 440 /etc/sudoers.d/90-deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$PUBKEY" /home/deploy/.ssh/authorized_keys 2>/dev/null ||
  echo "$PUBKEY" >>/home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# Swap: `pnpm install` and `next build` peak around 2 GB.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# Docker Engine + Compose plugin.
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker deploy

# Firewall: SSH only. The app is reached through Cloudflare Tunnel (outbound), and
# docker-compose.prod.yml publishes no port (Docker would bypass UFW otherwise).
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# SSH: keys only, no root login. Checked first so a typo cannot lock us out.
cat >/etc/ssh/sshd_config.d/90-tms.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh || systemctl reload sshd

timedatectl set-timezone Asia/Ho_Chi_Minh
echo "Done. Log in again as: ssh deploy@<VPS_IP>"
