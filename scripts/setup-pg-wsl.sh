#!/bin/bash
# Configure the WSL PostgreSQL so the Windows host can reach it directly through
# the WSL vEthernet IP. This deliberately avoids the WSL2 "localhost relay"
# (port forwarding), which on this machine drops connections intermittently and
# caused ECONNREFUSED 127.0.0.1:5432 inside the Next.js dev server.
#
# Idempotent: re-running only restarts PostgreSQL when something actually changed.
# Must run as root:  wsl -d Ubuntu -u root -- bash /mnt/d/AI_APP/openmaic/scripts/setup-pg-wsl.sh

CONFFILE=/etc/postgresql/16/main/postgresql.conf
HBAFILE=/etc/postgresql/16/main/pg_hba.conf
CLUSTER=16
PORT=5432
SUBNET=172.16.0.0/12

CHANGED=0

echo "[1] listen_addresses = '*'"
if grep -qE "^[[:space:]]*listen_addresses[[:space:]]*=[[:space:]]*'\*'" "$CONFFILE"; then
  echo "    already set"
else
  if grep -qE "^[[:space:]]*listen_addresses" "$CONFFILE"; then
    sed -i "s|^[[:space:]]*listen_addresses.*|listen_addresses = '*'|" "$CONFFILE"
  elif grep -qE "^[[:space:]]*#listen_addresses" "$CONFFILE"; then
    sed -i "s|^[[:space:]]*#listen_addresses.*|listen_addresses = '*'|" "$CONFFILE"
  else
    echo "listen_addresses = '*'" >> "$CONFFILE"
  fi
  echo "    updated"
  CHANGED=1
fi

echo "[2] pg_hba: password auth for the WSL subnet ${SUBNET}"
if grep -q "$SUBNET" "$HBAFILE"; then
  echo "    already present"
else
  printf 'host    all             all             %s            md5\n' "$SUBNET" >> "$HBAFILE"
  echo "    appended"
  CHANGED=1
fi

if [ "$CHANGED" = "1" ]; then
  echo "[3] config changed -> restarting PostgreSQL ${CLUSTER}/main"
  if ! pg_ctlcluster "$CLUSTER" main restart; then
    pg_ctlcluster "$CLUSTER" main start || true
  fi
  sleep 1
else
  echo "[3] config unchanged -> ensuring PostgreSQL is running"
  if ! pg_isready -h 127.0.0.1 -p "$PORT" -q; then
    pg_ctlcluster "$CLUSTER" main start || true
  fi
fi

echo "[4] listen sockets on ${PORT}:"
ss -tlnp 2>/dev/null | grep ":$PORT" || echo "    (none)"

echo "[Done]"
