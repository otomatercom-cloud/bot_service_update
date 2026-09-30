#!/usr/bin/env bash
#
# teardown_officer_bot.sh - removes one Admission Officer's WhatsApp bot
# instance completely: stops + deletes its PM2 process, deletes its
# folder (auth_info, .env, node_modules, everything). Mirrors
# setup_officer_bot.sh in reverse.
#
# USAGE:
#   ./teardown_officer_bot.sh <officer_slug>
#
# EXAMPLE:
#   ./teardown_officer_bot.sh ajesh
#
# Run this from the parent addons folder, same as setup_officer_bot.sh:
#   cd /opt/elysians/otomater-custom-addons
#   /path/to/teardown_officer_bot.sh ajesh
#
# This is DESTRUCTIVE - the officer's WhatsApp pairing (auth_info) is
# deleted and cannot be recovered; re-adding them later requires a fresh
# QR scan. It does NOT touch WhatsApp itself - the linked device entry on
# the officer's own phone should be removed separately if you still have
# access to it (WhatsApp > Linked Devices > Log out), otherwise it will
# just sit there unused.

set -euo pipefail

OFFICER="${1:-}"

if [ -z "$OFFICER" ]; then
  echo "Usage: $0 <officer_slug>"
  echo "Example: $0 ajesh"
  exit 1
fi

TARGET_DIR="otm_whatsapp_lead_bot_${OFFICER}"
PM2_NAME="whatsapp-lead-${OFFICER}"

echo "==> Tearing down $TARGET_DIR (PM2 process: $PM2_NAME)"

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 stop "$PM2_NAME" || true
  pm2 delete "$PM2_NAME" || true
  pm2 save
else
  echo "    (no PM2 process named $PM2_NAME - already stopped or never started)"
fi

if [ -d "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR"
  echo "    Deleted folder: $TARGET_DIR"
else
  echo "    (no folder named $TARGET_DIR - already removed)"
fi

echo "==> Done. Remember to also log this officer's device out of WhatsApp"
echo "    (on their phone: Linked Devices) if you still have access to it."
