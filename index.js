"use strict";
require("dotenv").config();

const express = require("express");
const pino = require("pino");
const { createWhatsappManager } = require("./whatsapp");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = parseInt(process.env.PORT || "8721", 10);
const API_TOKEN = process.env.API_TOKEN;
const AUTH_STATE_DIR = process.env.AUTH_STATE_DIR || "./auth_info";
// NEW, optional: when set, a direct WhatsApp quote-reply to a message this
// instance sent is forwarded here (otm_whatsapp_lead_scheduler's reply
// chatbot webhook). Blank/unset = feature simply off - nothing changes for
// an existing instance that doesn't have this var, no error, no extra load.
const ODOO_INBOUND_URL = process.env.ODOO_INBOUND_URL || "";

if (!API_TOKEN || API_TOKEN === "change-me-to-a-real-random-secret") {
  logger.error(
    "API_TOKEN is not set (or still the placeholder) in .env - refusing to start. " +
      "Generate one with: openssl rand -hex 32"
  );
  process.exit(1);
}

/**
 * Forwards a confirmed quote-reply to Odoo's inbound webhook, authenticated
 * with this SAME instance's own API_TOKEN (Odoo already knows it - it's the
 * same token Odoo uses to call this service's own /send-direct etc., so no
 * second secret needs provisioning anywhere). Uses the global fetch() built
 * into Node 18+ - no new dependency. Never throws: a webhook failure must
 * never crash the bot's own WhatsApp connection.
 */
async function forwardInboundReply({ from, text, quotedId }) {
  if (!ODOO_INBOUND_URL) {
    logger.info(
      { from, quotedId },
      "Quote-reply detected but ODOO_INBOUND_URL is not set on this instance - not forwarded"
    );
    return;
  }
  logger.info({ from, quotedId, url: ODOO_INBOUND_URL }, "Forwarding quote-reply to Odoo");
  try {
    const resp = await fetch(ODOO_INBOUND_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, text, quoted_id: quotedId }),
    });
    const body = await resp.text();
    if (!resp.ok) {
      logger.warn({ status: resp.status, body }, "Odoo inbound webhook returned a non-OK status");
    } else {
      logger.info({ status: resp.status, body }, "Odoo inbound webhook accepted the reply");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Could not reach Odoo's inbound webhook (ignored)");
  }
}

const wa = createWhatsappManager({
  authStateDir: AUTH_STATE_DIR,
  logLevel: process.env.LOG_LEVEL,
  onInboundReply: forwardInboundReply,
});

const app = express();
app.use(express.json({ limit: "150mb" })); // base64 media inflates ~33%; WhatsApp's own cap is ~100MB for documents

// Every route requires the shared bearer token - this is a private
// service meant to be reachable only from Odoo, never exposed publicly.
app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/status", (req, res) => {
  res.json(wa.getStatus());
});

app.get("/qr", (req, res) => {
  const qr = wa.getQr();
  res.json({ qr: qr || null });
});

app.get("/groups", async (req, res) => {
  try {
    const groups = await wa.listGroups();
    res.json({ groups });
  } catch (err) {
    logger.warn({ err: err.message, code: err.code }, "Group list failed");
    res.status(err.code === "NOT_CONNECTED" ? 503 : 400).json({
      error: err.message,
      code: err.code || "LIST_FAILED",
    });
  }
});

app.post("/send", async (req, res) => {
  const { group_id: groupId, message, media } = req.body || {};
  try {
    const result = await wa.sendGroupMessage(groupId, message, media);
    res.json({ success: true, message_id: result.messageId });
  } catch (err) {
    logger.warn({ err: err.message, code: err.code, groupId }, "Group send failed");
    res.status(err.code === "NOT_CONNECTED" ? 503 : 400).json({
      success: false,
      error: err.message,
      code: err.code || "SEND_FAILED",
    });
  }
});

// NEW: sends to one customer's phone number, not a group - used by
// otm_whatsapp_lead_scheduler's LeadBotClient.send_direct_message(). Wire
// format deliberately mirrors POST /send above (same success/error/code
// shape) so both clients on the Odoo side share one _parse() helper.
app.post("/send-direct", async (req, res) => {
  const { to, message, media } = req.body || {};
  try {
    const result = await wa.sendDirectMessage(to, message, media);
    res.json({ success: true, message_id: result.messageId });
  } catch (err) {
    logger.warn({ err: err.message, code: err.code, to }, "Direct send failed");
    res.status(err.code === "NOT_CONNECTED" ? 503 : 400).json({
      success: false,
      error: err.message,
      code: err.code || "SEND_FAILED",
    });
  }
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error({ err }, "Unhandled error in request");
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "otm-whatsapp-bot-service listening");
});

wa.start().catch((err) => {
  logger.error({ err }, "Failed to start WhatsApp connection");
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
