#!/usr/bin/env bash
# Deploys this working tree to a server and (re)starts the production stack.
#
#   deploy/deploy.sh ubuntu@<server-ip> [domain]
#
# Without a domain, <ip-with-dashes>.sslip.io is used: a public DNS name that
# resolves to the IP it spells, so Caddy can get a real HTTPS certificate for
# a server that has no domain of its own.
#
# First run: prepares the server (deploy/server-setup.sh) and writes its .env
# from this machine's, with fresh secrets. Later runs only sync the code and
# rebuild; the server's .env, database and uploads are never overwritten.
set -euo pipefail

host=${1:?usage: deploy/deploy.sh ubuntu@<server-ip> [domain]}
ip=${host#*@}
domain=${2:-${ip//./-}.sslip.io}
key=${TRACE_SSH_KEY:-$HOME/.ssh/trace_deploy}
ssh_opts=(-i "$key" -o StrictHostKeyChecking=accept-new)
remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }

cd "$(dirname "$0")/.."

echo "==> syncing code to $host:~/trace"
remote 'mkdir -p ~/trace'
rsync -az --delete -e "ssh ${ssh_opts[*]}" \
  --exclude .git --exclude node_modules --exclude '**/node_modules' --exclude '**/dist' \
  --exclude .turbo --exclude '**/__pycache__' --exclude .env --exclude data \
  --exclude 'eval/reports' --exclude '*.docx' \
  ./ "$host:~/trace/"

remote 'bash ~/trace/deploy/server-setup.sh'

if ! remote 'test -f ~/trace/.env'; then
  echo "==> writing the server's .env (first deploy)"
  [ -f .env ] || { echo "no local .env to take API keys from" >&2; exit 1; }
  {
    # API keys and model choices from this machine; everything that must
    # differ on a public server is replaced below.
    grep -vE '^(JWT_SECRET|POSTGRES_PASSWORD|TRACE_DOMAIN|COOKIE_SECURE|CORS_ORIGIN|NODE_ENV|SIGNUP_ALLOWLIST|VITE_API_URL)=' .env
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "TRACE_DOMAIN=$domain"
    # Who may register. Edit ~/trace/.env on the server and redeploy to change.
    echo "SIGNUP_ALLOWLIST=${SIGNUP_ALLOWLIST:-}"
  } | remote 'umask 077 && cat > ~/trace/.env'
fi

echo "==> building and starting (the first build takes 15-25 minutes)"
# `sg docker` because the group added by server-setup.sh applies to new
# logins only, and this is still the first one.
remote "cd ~/trace && sg docker -c 'docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans'"

echo "==> waiting for https://$domain"
for _ in $(seq 1 60); do
  if curl -fsS "https://$domain/api/healthz" >/dev/null 2>&1; then
    echo "trace is live at https://$domain"
    exit 0
  fi
  sleep 10
done
echo "not answering yet; check with: ssh -i $key $host 'cd ~/trace && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail 50'" >&2
exit 1
