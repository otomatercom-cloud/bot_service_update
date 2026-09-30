#!/usr/bin/env bash
#
# setup_officer_bot.sh - creates one Admission Officer's WhatsApp bot
# instance for otm_whatsapp_lead_scheduler: its own folder, own port,
# own auth_info (fresh pairing), own API token, own PM2 process.
#
# One instance per officer is intentional (see otm_whatsapp_lead_scheduler
# design notes) - Baileys keeps exactly one WhatsApp session per process,
# so each officer's number needs its own process.
#
# USAGE:
#   ./setup_officer_bot.sh <officer_slug> [port]
#
# EXAMPLE:
#   ./setup_officer_bot.sh priya
#   ./setup_officer_bot.sh anand 8734
#
# If [port] is omitted, the script picks the next free port starting
# from BASE_PORT by scanning existing otm_whatsapp_lead_bot_* folders'
# .env files.
#
# Run this from the parent addons folder, e.g.:
#   cd /opt/elysians/otomater-custom-addons
#   /path/to/setup_officer_bot.sh priya
#
# MULTI-CLIENT: this script is meant to be identical across every client's
# server - nothing client-specific should be hardcoded below. Per-client
# differences (base port range, country code, template folder name) are
# read from an optional bot_service_update.conf file sitting next to this
# script; if that file is absent, the defaults below are used as-is. Copy
# bot_service_update.conf.example to bot_service_update.conf on any server
# whose defaults need to differ (e.g. a non-India client's country code).

set -euo pipefail

UPDATE_FILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # this script's own folder (bot_service_update/)

# ---- Defaults - override per client via bot_service_update.conf, never here ----
TEMPLATE_DIR="otm_whatsapp_group_bot_service"   # known-good base to copy from
BASE_PORT=8732
DEFAULT_COUNTRY_CODE=91
# -------------------------------------------------------------------

CONF_FILE="${UPDATE_FILES_DIR}/bot_service_update.conf"
if [ -f "$CONF_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONF_FILE"
fi

OFFICER="${1:-}"
PORT="${2:-}"

if [ -z "$OFFICER" ]; then
  echo "Usage: $0 <officer_slug> [port]"
  echo "Example: $0 priya"
  exit 1
fi

TARGET_DIR="otm_whatsapp_lead_bot_${OFFICER}"
PM2_NAME="whatsapp-lead-${OFFICER}"

if [ -d "$TARGET_DIR" ]; then
  echo "ERROR: $TARGET_DIR already exists. Refusing to overwrite an existing officer's instance."
  echo "If you really mean to recreate it, remove it manually first (this will lose its pairing)."
  exit 1
fi

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "ERROR: template folder '$TEMPLATE_DIR' not found in $(pwd)."
  echo "Run this script from the folder that contains it (your addons folder), or edit TEMPLATE_DIR."
  exit 1
fi

# ---- Pick a free port if not given ----
if [ -z "$PORT" ]; then
  PORT=$BASE_PORT
  while true; do
    IN_USE=0
    for envfile in otm_whatsapp_lead_bot_*/.env otm_whatsapp_group_bot_service/.env; do
      [ -f "$envfile" ] || continue
      if grep -q "^PORT=${PORT}$" "$envfile" 2>/dev/null; then
        IN_USE=1
        break
      fi
    done
    if [ "$IN_USE" -eq 0 ]; then
      break
    fi
    PORT=$((PORT + 1))
  done
fi

echo "==> Creating $TARGET_DIR (officer: $OFFICER, port: $PORT, PM2 process: $PM2_NAME)"

# ---- Copy template, strip any pairing state ----
cp -r "$TEMPLATE_DIR" "$TARGET_DIR"
rm -rf "${TARGET_DIR}/auth_info"

# ---- Drop in the updated bot-service files (country-code fix + /send-direct) ----
cp "${UPDATE_FILES_DIR}/whatsapp.js" "${TARGET_DIR}/src/whatsapp.js"
cp "${UPDATE_FILES_DIR}/index.js" "${TARGET_DIR}/src/index.js"

# ---- Generate a fresh API token and .env ----
if command -v openssl >/dev/null 2>&1; then
  TOKEN=$(openssl rand -hex 16)
else
  TOKEN=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

cat > "${TARGET_DIR}/.env" <<EOF
PORT=${PORT}
AUTH_STATE_DIR=./auth_info
API_TOKEN=${TOKEN}
DEFAULT_COUNTRY_CODE=${DEFAULT_COUNTRY_CODE}
LOG_LEVEL=info
EOF

# ---- Install deps and start under PM2 ----
# --interpreter is pinned explicitly to whatever Node this SCRIPT is
# currently running under (not left to PM2's default "node" lookup).
# PM2's background daemon locks in the Node version that was active when
# the daemon itself first started, and silently keeps using that for
# every future `pm2 start`, even if the shell's active Node has since
# been upgraded (e.g. via nvm). If that daemon started under an old
# Node, newer packages that are ESM-only (like recent
# @whiskeysockets/baileys releases) fail with ERR_REQUIRE_ESM - same
# files, wrong runtime. Pinning it here makes every new instance
# immune to that, regardless of what Node version PM2's daemon happens
# to be stuck on.
NODE_BIN="$(command -v node)"
(
  cd "$TARGET_DIR"
  npm install
  pm2 start src/index.js --name "$PM2_NAME" --interpreter "$NODE_BIN"
)
pm2 save

echo ""
echo "============================================================"
echo " Instance created:  $TARGET_DIR"
echo " PM2 process:       $PM2_NAME"
echo " Port:               $PORT"
echo " API Token:          $TOKEN"
echo "============================================================"
echo ""
echo "Next steps:"
echo "1. Check status:"
echo "   curl http://127.0.0.1:${PORT}/status -H 'Authorization: Bearer ${TOKEN}'"
echo "2. Get the QR (pm2 logs ${PM2_NAME} --lines 30 --nostream, or via Odoo's Refresh QR"
echo "   once step 3 is done) and scan it from THIS OFFICER'S OWN phone (Linked Devices)."
echo "3. In Odoo: WhatsApp > Configuration > Lead Bot Connections > New"
echo "     Admission Officer : this officer's user"
echo "     Base URL          : http://127.0.0.1:${PORT}"
echo "     API Token         : ${TOKEN}"
echo "   Save, then click Check Connection - should show Connected."
echo ""
echo "Save this token somewhere safe - it is only printed once."
