"use strict";
/**
 * Thin wrapper around Baileys (an UNOFFICIAL WhatsApp Web protocol
 * library - not Meta's Cloud API). This exists only because Meta's
 * official WhatsApp Business Platform has no group-send capability at
 * all, and because otm_whatsapp_lead_scheduler needs a per-Admission-
 * Officer number that is NOT the Coexistence/Cloud API number either.
 * Using this violates WhatsApp's Terms of Service and carries a real ban
 * risk for the connected number - that's a business decision made outside
 * this code, not something this file tries to hide or minimize.
 *
 * Keeps exactly one persistent socket alive, auto-reconnecting on drop
 * (except after an explicit logout, which requires a fresh QR scan).
 *
 * CHANGE FROM THE ORIGINAL otm_whatsapp_group_bot_service/src/whatsapp.js:
 * added sendDirectMessage() below, alongside the existing
 * sendGroupMessage() - purely additive, nothing else in this file
 * changed. Every officer runs their OWN instance of this exact file (own
 * port, own AUTH_STATE_DIR, own .env) - this is NOT a multi-session
 * rewrite, just one more capability on the same single-session service.
 */

const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");

function createWhatsappManager({ authStateDir, logLevel, onInboundReply }) {
  const logger = pino({ level: logLevel || "info" });
  const baileysLogger = pino({ level: "warn" }); // Baileys itself is very chatty on "info"

  const state = {
    sock: null,
    connectionState: "disconnected", // disconnected | connecting | qr_pending | connected
    qrDataUrl: null,
    phoneNumber: null,
    lastError: null,
  };

  async function start() {
    state.connectionState = "connecting";
    const { state: authState, saveCreds } = await useMultiFileAuthState(
      path.resolve(authStateDir)
    );
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      logger: baileysLogger,
      // Printing the QR to the terminal too is handy for first-time setup
      // over SSH without needing to hit the HTTP endpoint.
      printQRInTerminal: true,
    });
    state.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    // NEW: forwards a customer's incoming message to the officer's own
    // Odoo (otm_whatsapp_lead_scheduler's optional reply chatbot) - see
    // onInboundReply below, wired up in index.js.
    //
    // CHANGED FROM THE ORIGINAL (reply-only) BEHAVIOUR: this used to only
    // forward a message that was an explicit WhatsApp quote-reply
    // (contextInfo.stanzaId set), and ignore anything else. Per an explicit
    // later decision, it now forwards ANY plain text message from the
    // customer too - quotedId is still captured and sent when present (the
    // Odoo side still prefers it, since it's the most precise match), but
    // its ABSENCE no longer blocks forwarding. Trade-off accepted knowingly:
    // every message the customer sends in this chat now gets matched to
    // "whatever this officer's bot last sent them" and can trigger an
    // auto-reply, not just explicit replies - there is no narrower signal
    // available once a customer is not required to swipe-reply.
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !onInboundReply) return;
      for (const msg of messages) {
        try {
          if (!msg.message || (msg.key && msg.key.fromMe)) continue; // only real customer messages

          const m = msg.message;
          const text =
            m.conversation ||
            (m.extendedTextMessage && m.extendedTextMessage.text) ||
            (m.imageMessage && m.imageMessage.caption) ||
            (m.videoMessage && m.videoMessage.caption) ||
            "";
          const ctx =
            (m.extendedTextMessage && m.extendedTextMessage.contextInfo) ||
            (m.imageMessage && m.imageMessage.contextInfo) ||
            (m.videoMessage && m.videoMessage.contextInfo) ||
            null;
          const quotedId = ctx && ctx.stanzaId ? ctx.stanzaId : null;
          if (!text && !quotedId) continue; // nothing to match against (e.g. a sticker/reaction)

          await onInboundReply({ from: msg.key.remoteJid, text, quotedId });
        } catch (err) {
          logger.warn({ err }, "Failed handling an inbound message (ignored, bot keeps running)");
        }
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.connectionState = "qr_pending";
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr);
        } catch (err) {
          logger.error({ err }, "Failed to render QR code to a data URL");
        }
      }

      if (connection === "open") {
        state.connectionState = "connected";
        state.qrDataUrl = null;
        state.lastError = null;
        state.phoneNumber = sock.user && sock.user.id ? sock.user.id.split(":")[0] : null;
        logger.info({ phoneNumber: state.phoneNumber }, "WhatsApp bot connected");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect &&
          lastDisconnect.error &&
          lastDisconnect.error.output &&
          lastDisconnect.error.output.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        state.connectionState = "disconnected";
        state.lastError = lastDisconnect && lastDisconnect.error ? String(lastDisconnect.error) : null;
        logger.warn({ statusCode, loggedOut }, "WhatsApp bot connection closed");

        if (loggedOut) {
          // Session was invalidated (logged out from the phone, or banned).
          // Requires a brand-new QR scan - do NOT auto-reconnect in a loop,
          // that would just spam WhatsApp's servers.
          state.qrDataUrl = null;
          logger.error(
            "Session logged out - delete AUTH_STATE_DIR and restart this service to pair again."
          );
        } else {
          // Transient drop (network blip, restart, etc.) - reconnect.
          setTimeout(() => start().catch((err) => logger.error({ err }, "Reconnect failed")), 3000);
        }
      }
    });

    return sock;
  }

  function getStatus() {
    return {
      state: state.connectionState,
      connected: state.connectionState === "connected",
      phone_number: state.phoneNumber,
      last_error: state.lastError,
    };
  }

  function getQr() {
    return state.qrDataUrl;
  }

  /**
   * Lists every group the paired number is currently a participant in -
   * the practical way to discover a group's real JID for registering it
   * in Odoo, instead of digging through logs.
   */
  async function listGroups() {
    if (state.connectionState !== "connected" || !state.sock) {
      const err = new Error("WhatsApp bot is not connected (state=" + state.connectionState + ")");
      err.code = "NOT_CONNECTED";
      throw err;
    }
    const groups = await state.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participant_count: Array.isArray(g.participants) ? g.participants.length : null,
    }));
  }

  /**
   * Sends a text and/or media message to a WhatsApp Group.
   * `groupId` must be the full JID, e.g. "120363xxxxxxxxxx@g.us".
   * `media`: optional { base64, mimeType, fileName, mediaType } where
   * mediaType is one of image|video|document.
   */
  async function sendGroupMessage(groupId, text, media) {
    if (state.connectionState !== "connected" || !state.sock) {
      const err = new Error("WhatsApp bot is not connected (state=" + state.connectionState + ")");
      err.code = "NOT_CONNECTED";
      throw err;
    }
    if (!groupId || !groupId.endsWith("@g.us")) {
      const err = new Error(
        "groupId must be a full WhatsApp group JID ending in '@g.us', got: " + groupId
      );
      err.code = "INVALID_GROUP_ID";
      throw err;
    }

    const content = _buildContent(text, media);
    const result = await state.sock.sendMessage(groupId, content);
    return { messageId: result && result.key ? result.key.id : null };
  }

  /**
   * NEW: sends a text message to ONE customer's phone number (not a
   * group) - this is what otm_whatsapp_lead_scheduler's POST /send-direct
   * route calls. `to` accepts a plain number as typed on the lead
   * ("9198xxxxxxxx", "+9198xxxxxxxx", with spaces/dashes) and this
   * function normalises it into a WhatsApp JID
   * ("9198xxxxxxxx@s.whatsapp.net") - Odoo never needs to know the JID
   * format, only the raw number it already has.
   */
  async function sendDirectMessage(to, text, media) {
    if (state.connectionState !== "connected" || !state.sock) {
      const err = new Error("WhatsApp bot is not connected (state=" + state.connectionState + ")");
      err.code = "NOT_CONNECTED";
      throw err;
    }
    const jid = _toJid(to);
    if (!jid) {
      const err = new Error("Could not build a valid WhatsApp JID from: " + to);
      err.code = "INVALID_NUMBER";
      throw err;
    }

    const content = _buildContent(text, media);
    const result = await state.sock.sendMessage(jid, content);
    // result.key.remoteJid is Baileys' own resolved chat identity for this
    // send - it can differ from the plain "<number>@s.whatsapp.net" we
    // passed in (e.g. WhatsApp's newer "@lid" linked-identity addressing).
    // Recording THIS exact value (not the number we built) is what lets a
    // later incoming message's own remoteJid be matched back to this chat
    // even when the customer doesn't swipe-reply - see messages.upsert
    // above and lead_whatsapp_inbound.py's fallback lookup.
    return {
      messageId: result && result.key ? result.key.id : null,
      jid: (result && result.key && result.key.remoteJid) || jid,
    };
  }

  function _buildContent(text, media) {
    if (media && media.base64) {
      const buffer = Buffer.from(media.base64, "base64");
      if (media.mediaType === "image") {
        return { image: buffer, caption: text || undefined, mimetype: media.mimeType };
      }
      if (media.mediaType === "video") {
        return { video: buffer, caption: text || undefined, mimetype: media.mimeType };
      }
      return {
        document: buffer,
        fileName: media.fileName || "attachment",
        mimetype: media.mimeType || "application/octet-stream",
        caption: text || undefined,
      };
    }
    if (!text) {
      const err = new Error("Either text or media is required");
      err.code = "EMPTY_MESSAGE";
      throw err;
    }
    return { text };
  }

  /**
   * Strips everything but digits and appends "@s.whatsapp.net" - the
   * individual-chat JID suffix (as opposed to "@g.us" for groups).
   *
   * Odoo's "phone_number" on a lead is usually stored as a bare LOCAL
   * number with no country code (e.g. "7994483315"), since that's how
   * admission officers type it in. WhatsApp JIDs need the FULL
   * international number, so a bare 10-digit number gets
   * DEFAULT_COUNTRY_CODE (env var, defaults to "91" for India) prepended.
   * Without this, sendMessage() still resolves to *some* JID and Baileys
   * reports success, but the message is never actually delivered to the
   * real contact - it silently goes nowhere.
   *
   * Returns null for anything that doesn't leave at least 8 digits, so a
   * blank or garbage phone number on the lead fails with INVALID_NUMBER
   * instead of silently messaging a wrong/empty JID.
   */
  function _toJid(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^0-9]/g, "");
    if (!digits) return null;

    const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "91";
    // Bare 10-digit local mobile number (India) - prepend the country code.
    if (digits.length === 10) {
      digits = DEFAULT_COUNTRY_CODE + digits;
    }
    // Someone typed a leading 0 before the local number (e.g. "07994483315").
    if (digits.length === 11 && digits.startsWith("0")) {
      digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
    }

    if (digits.length < 8) return null;
    return digits + "@s.whatsapp.net";
  }

  return { start, getStatus, getQr, listGroups, sendGroupMessage, sendDirectMessage };
}

module.exports = { createWhatsappManager };
