# Bot service update - one instance per Admission Officer

These two files (`whatsapp.js`, `index.js`) are drop-in replacements for
the SAME files inside your existing `otm_whatsapp_group_bot_service`
project. The only change is additive: a new `sendDirectMessage()` function
and a new `POST /send-direct` route, sitting right alongside the existing
group-send code. Nothing about group messaging changed - your current
group-bot instance keeps working exactly as before if you update it too.

## What did NOT change

* Still exactly one WhatsApp session per running process (no multi-tenant
  rewrite).
* Same `.env` variables: `PORT`, `API_TOKEN`, `AUTH_STATE_DIR`,
  `LOG_LEVEL`.
* Same `/status`, `/qr`, `/groups`, `/send` routes, byte-for-byte.

## How to give each Admission Officer their own number

Each officer's WhatsApp connection is a **separate deployment** of this
same project - own folder, own `.env`, own port, own `AUTH_STATE_DIR`, own
QR scan. For example, with 3 officers:

```
otm-whatsapp-lead-bot-anjali/   PORT=8731  AUTH_STATE_DIR=./auth_info
otm-whatsapp-lead-bot-farhan/   PORT=8732  AUTH_STATE_DIR=./auth_info
otm-whatsapp-lead-bot-meera/    PORT=8733  AUTH_STATE_DIR=./auth_info
```

Run each with its own PM2 process (or systemd unit) so they survive
reboots independently, e.g.:

```
pm2 start index.js --name whatsapp-lead-bot-anjali --cwd ./otm-whatsapp-lead-bot-anjali
pm2 start index.js --name whatsapp-lead-bot-farhan --cwd ./otm-whatsapp-lead-bot-farhan
```

In Odoo, create one `otm.whatsapp.lead.bot` record per officer (WhatsApp >
Configuration > Lead Bot Connections), each pointing at that officer's own
`base_url` (e.g. `http://127.0.0.1:8731`) and `api_token` (must match that
instance's `.env`).

## `POST /send-direct`

Request:
```json
{ "to": "9198xxxxxxxx", "message": "Hi, this is a reminder..." }
```
`to` is the plain phone number exactly as stored on the lead (spaces/`+`
are stripped automatically) - the service builds the WhatsApp JID itself.

Response (same shape as `/send`):
```json
{ "success": true, "message_id": "3EB0..." }
```
or
```json
{ "success": false, "error": "...", "code": "NOT_CONNECTED" }
```
