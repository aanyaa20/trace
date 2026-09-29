#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu server (22.04 or 24.04, x86 or ARM).
# Run by deploy.sh on first contact; safe to run again.
#
#   - installs Docker Engine and the Compose plugin from Docker's repository
#   - opens 80 and 443 in the host firewall: Oracle's Ubuntu images ship an
#     iptables policy that rejects everything but SSH, so the cloud security
#     list alone is not enough
#   - schedules the nightly backup
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg rsync
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

echo "==> opening ports 80 and 443"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    # Inserted ahead of the image's final REJECT rule.
    sudo iptables -I INPUT 5 -p tcp --dport "$port" -j ACCEPT
  fi
done
if ! sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 5 -p udp --dport 443 -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save >/dev/null
fi

echo "==> scheduling the nightly backup (03:15 server time)"
mkdir -p "$HOME/backups"
( crontab -l 2>/dev/null | grep -v 'trace/deploy/backup.sh' ; echo "15 3 * * * $HOME/trace/deploy/backup.sh >> $HOME/backups/backup.log 2>&1" ) | crontab -

echo "==> server ready"
