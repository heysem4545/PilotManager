const { setGlobalOptions } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const twilio = require("twilio");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { initializeApp } = require("firebase-admin/app");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");

// Internal helper: call Telegram Bot API sendMessage.
async function _telegramSend(token, chatId, text, opts) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = Object.assign(
    { chat_id: chatId, text: text, parse_mode: "Markdown" },
    opts || {}
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || ("Telegram API error " + res.status));
  }
  return data.result;
}

// Webhook: Telegram POSTs every message a user sends our bot here. We reply
// to `/start` with the user's Chat ID so they can copy it into PilotManager.
exports.telegramWebhook = onRequest({ secrets: [TELEGRAM_BOT_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") { res.status(200).send("ok"); return; }
  const update = req.body || {};
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) { res.status(200).send("ok"); return; }

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const firstName = (msg.from && msg.from.first_name) || "there";
  const token = TELEGRAM_BOT_TOKEN.value();

  let reply;
  if (text.startsWith("/start") || text === "/id" || text === "/myid") {
    reply = "👋 Hi " + firstName + "!\n\nYour PilotManager Telegram Chat ID is:\n\n`" + chatId + "`\n\nCopy that number and ask your PilotManager admin to add it to your profile so you start getting alerts.";
  } else {
    reply = "Send /start to get your Chat ID for PilotManager.";
  }

  try {
    await _telegramSend(token, chatId, reply);
  } catch (e) {
    logger.error("telegram reply failed", e);
  }
  res.status(200).send("ok");
});

// One-time setup: admin calls this to point Telegram's bot webhook at the
// deployed telegramWebhook function. Reads the stored secret so we never
// need the literal token in client code or terminal.
exports.setupTelegramWebhook = onCall({ secrets: [TELEGRAM_BOT_TOKEN] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const firestore = getFirestore();
  const callerDoc = await firestore.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin only");
  }
  const token = TELEGRAM_BOT_TOKEN.value();
  const webhookUrl = "https://us-central1-pilotmanager-b61e9.cloudfunctions.net/telegramWebhook";
  try {
    // Verify token first
    const meRes = await fetch("https://api.telegram.org/bot" + token + "/getMe");
    const me = await meRes.json();
    if (!me.ok) {
      throw new HttpsError("failed-precondition", "Stored token is invalid: " + (me.description || "unknown"));
    }
    // Set webhook
    const setRes = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const setData = await setRes.json();
    if (!setData.ok) {
      throw new HttpsError("internal", setData.description || "setWebhook failed");
    }
    return { ok: true, botUsername: me.result.username, webhookUrl: webhookUrl };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", e.message || "setup failed");
  }
});

// Callable: send a Telegram message to a specific chat ID. Used by the
// PilotManager UI (Team page "Test Telegram" button, future notification
// triggers, etc.). Requires signed-in user.
exports.sendTelegramMessage = onCall({ secrets: [TELEGRAM_BOT_TOKEN] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const data = request.data || {};
  const chatId = data.chatId;
  const message = data.message;
  if (!chatId || !message) {
    throw new HttpsError("invalid-argument", "chatId and message required");
  }
  const token = TELEGRAM_BOT_TOKEN.value();
  try {
    const result = await _telegramSend(token, chatId, message);
    return { ok: true, messageId: result.message_id };
  } catch (e) {
    throw new HttpsError("internal", e.message || "Telegram send failed");
  }
});

// Admin-only: mint a Firebase custom token for another user so an admin can
// sign in as them and see exactly what they see. Logged for audit.
// Cannot impersonate self or another admin (privilege protection).
exports.impersonateUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const callerUid = request.auth.uid;
  const firestore = getFirestore();
  const callerDoc = await firestore.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin only");
  }
  const targetUid = request.data && request.data.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "targetUid required");
  }
  if (targetUid === callerUid) {
    throw new HttpsError("invalid-argument", "Cannot impersonate yourself");
  }
  const targetDoc = await firestore.collection("users").doc(targetUid).get();
  if (!targetDoc.exists) {
    throw new HttpsError("not-found", "Target user not found");
  }
  if (targetDoc.data().role === "admin") {
    throw new HttpsError("permission-denied", "Cannot impersonate another admin");
  }
  await firestore.collection("impersonationLog").add({
    actorUid: callerUid,
    actorEmail: callerDoc.data().email || null,
    actorName: callerDoc.data().name || null,
    targetUid: targetUid,
    targetEmail: targetDoc.data().email || null,
    targetName: targetDoc.data().name || null,
    timestamp: new Date(),
  });
  const token = await getAuth().createCustomToken(targetUid, {
    impersonatedBy: callerUid,
    impersonatorEmail: callerDoc.data().email || null,
    impersonatorName: callerDoc.data().name || null,
  });
  return { token };
});

// Pair of impersonateUser: mints a token to return to the admin's own
// session without re-entering a password. Validates via the impersonatedBy
// custom claim that was placed on the impersonation token; only the user
// the admin signed in as can call this.
exports.returnToAdmin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in required");
  }
  const claims = request.auth.token || {};
  const adminUid = claims.impersonatedBy;
  if (!adminUid) {
    throw new HttpsError("permission-denied", "Not in impersonation mode");
  }
  const firestore = getFirestore();
  const adminDoc = await firestore.collection("users").doc(adminUid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Original admin no longer exists or is no longer admin");
  }
  await firestore.collection("impersonationLog").add({
    action: "return",
    fromUid: request.auth.uid,
    toUid: adminUid,
    timestamp: new Date(),
  });
  const token = await getAuth().createCustomToken(adminUid);
  return { token };
});

// Secrets (stored in Google Cloud Secret Manager, not in code)
const TWILIO_SID = defineSecret("TWILIO_SID");
const TWILIO_AUTH = defineSecret("TWILIO_AUTH");
const TWILIO_WA_FROM = defineSecret("TWILIO_WA_FROM");
const ADMIN_WA_TO = defineSecret("ADMIN_WA_TO");
const SMS_FROM = defineSecret("SMS_FROM");
const SMS_TO = defineSecret("SMS_TO");

const firestore = getFirestore();

// Helper: log sent notification
async function logNotification(channel, trigger, recipientName, recipientContact, message, status) {
  try {
    await firestore.collection("notificationLogs").add({
      channel, trigger, recipientName, recipientContact, message, status,
      sentAt: new Date(),
      sentDate: new Date().toISOString().slice(0, 19).replace("T", " "),
    });
  } catch (e) {
    logger.error("Failed to log notification:", e.message);
  }
}

// Send a Telegram alert when a new Innovation item is submitted.
exports.onNewInnovation = onDocumentCreated(
  { document: "innovation/{docId}", secrets: [TELEGRAM_BOT_TOKEN] },
  async (event) => {
    const data = event.data.data();
    if (!data) return;

    const type = data.type || "Unknown";
    const urgent = data.urgentLevel || "Medium";
    const user = data.userName || "Unknown";
    const desc = (data.description || "").substring(0, 200);
    const emoji = type === "Bug" ? "🐛" : "💡";
    const urgentEmoji = { Low: "🟢", Medium: "🟡", High: "🔴", Critical: "🚨" }[urgent] || "🟡";

    const message = `${emoji} New ${type} — PilotManager\n\n` +
      `👤 From: ${user}\n` +
      `${urgentEmoji} Urgent: ${urgent}\n` +
      `📅 Date: ${data.date || "N/A"}\n\n` +
      `📝 ${desc}`;

    // Telegram rules only — WhatsApp/SMS/Email rules are ignored for now.
    try {
      const rulesSnap = await firestore.collection("notificationRules")
        .where("trigger", "==", "New Innovation Submitted")
        .where("active", "==", true)
        .get();

      const tgToken = TELEGRAM_BOT_TOKEN.value();
      for (const ruleDoc of rulesSnap.docs) {
        const rule = ruleDoc.data();
        if (rule.channel !== "telegram" || !rule.recipientContact) continue;
        try {
          await _telegramSend(tgToken, rule.recipientContact, message);
          await logNotification("telegram", "New Innovation Submitted", rule.recipientName, rule.recipientContact, message, "delivered");
        } catch (err) {
          await logNotification("telegram", "New Innovation Submitted", rule.recipientName, rule.recipientContact, message, "failed");
          logger.error(`Telegram to ${rule.recipientContact} failed:`, err.message);
        }
      }
    } catch (e) {
      logger.error("Error checking notification rules:", e.message);
    }
  }
);

// Daily SMS reminder at 6 PM EST
exports.dailyTechLogReminder = onSchedule(
  {
    schedule: "0 19 * * *",
    timeZone: "America/New_York",
    secrets: [TWILIO_SID, TWILIO_AUTH, SMS_FROM, SMS_TO],
  },
  async () => {
    const client = twilio(TWILIO_SID.value(), TWILIO_AUTH.value());
    const message = "Pilot Technician Daily Log";

    try {
      await client.messages.create({
        from: SMS_FROM.value(),
        to: SMS_TO.value(),
        body: message,
      });
      await logNotification("sms", "Daily Tech Log Reminder", "Owner", SMS_TO.value(), message, "delivered");
      logger.info("Daily SMS reminder sent");
    } catch (err) {
      await logNotification("sms", "Daily Tech Log Reminder", "Owner", SMS_TO.value(), message, "failed");
      logger.error("Daily SMS send failed:", err.message);
    }
  }
);
