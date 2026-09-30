#!/usr/bin/env python3
"""
provisioner.py - runs OUTSIDE Odoo, on a system cron schedule, as
whichever Linux user already owns PM2/npm on this server (the same user
who runs setup_officer_bot.sh by hand today).

Odoo itself never executes shell commands or touches PM2 - that would
give the Odoo web/cron process real shell execution rights on the
server, which is a privilege-escalation risk. Instead:

  1. An admin clicks "Create Bot Instance" on a Lead Bot Connection
     record in Odoo. That only sets provision_state='requested' - it
     does nothing on the server.
  2. THIS script polls Odoo over its normal external API (XML-RPC,
     stdlib only - no extra pip installs needed) for records in that
     state.
  3. For each one, it runs setup_officer_bot.sh <slug> exactly as a
     human would, reads the port/token it generated, and writes them
     back into the SAME Odoo record over the same API - exactly like
     any other external integration would.
  4. The officer still has to scan the QR with their own phone -
     nothing can automate that part.

This same script/code is meant to be dropped, UNCHANGED, onto every
client's server - everything that differs per client (Odoo URL, db,
credentials, and the addons folder path) lives in provisioner.env, never
in this file. Never edit ADDONS_DIR etc. below per client - edit
provisioner.env instead.

SETUP (once per client server):
  1. Put this file next to setup_officer_bot.sh (same bot_service_update/
     folder is fine) on that client's Odoo server.
  2. Copy provisioner.env.example to provisioner.env and fill in that
     client's Odoo URL/db/credentials/addons folder.
  3. Add a system cron entry (crontab -e, as the PM2-owning user - NOT
     necessarily root, whichever user already runs
     `pm2 start ...` today):

       */3 * * * * /usr/bin/python3 /path/to/bot_service_update/provisioner.py >> /var/log/otm_bot_provisioner.log 2>&1

  That's it - every 3 minutes it checks for new requests and actions them.
"""

import os
import subprocess
import sys
import xmlrpc.client
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, "provisioner.env")
SETUP_SCRIPT = os.path.join(SCRIPT_DIR, "setup_officer_bot.sh")

MODEL = "otm.whatsapp.lead.bot"


def load_config():
    if not os.path.exists(ENV_FILE):
        print(f"ERROR: {ENV_FILE} not found. Copy provisioner.env.example to provisioner.env "
              f"and fill in this client's Odoo connection details.", file=sys.stderr)
        sys.exit(1)
    cfg = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            cfg[key.strip()] = value.strip()
    # ADDONS_DIR defaults to this script's own folder's parent (bot_service_update/
    # normally sits directly inside the client's addons folder) if not set explicitly -
    # still overridable per client via provisioner.env or the OTM_ADDONS_DIR env var.
    cfg.setdefault(
        "ADDONS_DIR",
        os.environ.get("OTM_ADDONS_DIR", os.path.dirname(SCRIPT_DIR)),
    )
    required = ["ODOO_URL", "ODOO_DB", "ODOO_USERNAME", "ODOO_API_KEY"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        print(f"ERROR: {ENV_FILE} is missing: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    return cfg


def connect(cfg):
    common = xmlrpc.client.ServerProxy(f"{cfg['ODOO_URL']}/xmlrpc/2/common")
    uid = common.authenticate(cfg["ODOO_DB"], cfg["ODOO_USERNAME"], cfg["ODOO_API_KEY"], {})
    if not uid:
        print("ERROR: Odoo authentication failed - check ODOO_USERNAME/ODOO_API_KEY.", file=sys.stderr)
        sys.exit(1)
    models = xmlrpc.client.ServerProxy(f"{cfg['ODOO_URL']}/xmlrpc/2/object")
    return uid, models


def odoo_call(models, cfg, uid, method, *args, **kwargs):
    return models.execute_kw(
        cfg["ODOO_DB"], uid, cfg["ODOO_API_KEY"], MODEL, method, list(args), kwargs
    )


def run_setup_script(slug, addons_dir):
    """Runs setup_officer_bot.sh <slug>, then reads the .env it created
    to get the port/token back out (more robust than scraping stdout)."""
    result = subprocess.run(
        [SETUP_SCRIPT, slug],
        cwd=addons_dir,
        capture_output=True,
        text=True,
        timeout=600,  # npm install can be slow on a small server
    )
    log = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        raise RuntimeError(f"setup_officer_bot.sh exited {result.returncode}:\n{log[-4000:]}")

    env_path = os.path.join(addons_dir, f"otm_whatsapp_lead_bot_{slug}", ".env")
    if not os.path.exists(env_path):
        raise RuntimeError(f"Script reported success but {env_path} was not created:\n{log[-4000:]}")

    port, token = None, None
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("PORT="):
                port = line.split("=", 1)[1]
            elif line.startswith("API_TOKEN="):
                token = line.split("=", 1)[1]
    if not port or not token:
        raise RuntimeError(f"Could not read PORT/API_TOKEN back from {env_path}")
    return port, token, log


def main():
    cfg = load_config()
    uid, models = connect(cfg)

    requested_ids = odoo_call(
        models, cfg, uid, "search", [["provision_state", "=", "requested"]]
    )
    if not requested_ids:
        print(f"[{datetime.now(timezone.utc).isoformat()}] No provisioning requests pending.")
        return

    records = odoo_call(
        models, cfg, uid, "read", requested_ids, fields=["id", "name", "provision_slug", "user_id"]
    )

    for rec in records:
        slug = rec.get("provision_slug")
        print(f"==> Provisioning '{rec.get('name')}' (id={rec['id']}, slug={slug})")
        if not slug:
            odoo_call(
                models, cfg, uid, "write", [rec["id"]],
                {"provision_state": "error", "provision_error": "No instance slug set on the record."},
            )
            continue

        # Mark as in-progress immediately so a second cron tick (if this
        # run takes a while) doesn't pick up the same record twice.
        odoo_call(models, cfg, uid, "write", [rec["id"]], {"provision_state": "provisioning"})

        try:
            port, token, log = run_setup_script(slug, cfg["ADDONS_DIR"])
            odoo_call(
                models, cfg, uid, "write", [rec["id"]],
                {
                    "provision_state": "done",
                    "base_url": f"http://127.0.0.1:{port}",
                    "api_token": token,
                    "provision_done_date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                    "provision_error": False,
                },
            )
            print(f"    OK - port={port}, PM2 process=whatsapp-lead-{slug}")
        except Exception as exc:  # noqa: BLE001 - want to record any failure back into Odoo
            print(f"    FAILED: {exc}", file=sys.stderr)
            odoo_call(
                models, cfg, uid, "write", [rec["id"]],
                {"provision_state": "error", "provision_error": str(exc)[:4000]},
            )


if __name__ == "__main__":
    main()
