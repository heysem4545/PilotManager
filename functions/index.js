const { setGlobalOptions } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const twilio = require("twilio");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

// Secrets (stored in Google Cloud Secret Manager, not in code)
const TWILIO_SID = defineSecret("TWILIO_SID");
const TWILIO_AUTH = defineSecret("TWILIO_AUTH");
const TWILIO_WA_FROM = defineSecret("TWILIO_WA_FROM");
const ADMIN_WA_TO = defineSecret("ADMIN_WA_TO");

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

// Send WhatsApp when a new Innovation item is submitted
exports.onNewInnovation = onDocumentCreated(
  { document: "innovation/{docId}", secrets: [TWILIO_SID, TWILIO_AUTH, TWILIO_WA_FROM, ADMIN_WA_TO] },
  async (event) => {
    const data = event.data.data();
    if (!data) return;

    const client = twilio(TWILIO_SID.value(), TWILIO_AUTH.value());
    const fromWA = `whatsapp:${TWILIO_WA_FROM.value()}`;
    const adminWA = `whatsapp:${ADMIN_WA_TO.value()}`;

    const type = data.type || "Unknown";
    const urgent = data.urgentLevel || "Medium";
    const user = data.userName || "Unknown";
    const desc = (data.description || "").substring(0, 200);
    const emoji = type === "Bug" ? "🐛" : "💡";
    const urgentEmoji = { Low: "🟢", Medium: "🟡", High: "🔴", Critical: "🚨" }[urgent] || "🟡";

    const message = `${emoji} *New ${type}* — PilotManager\n\n` +
      `👤 From: ${user}\n` +
      `${urgentEmoji} Urgent: ${urgent}\n` +
      `📅 Date: ${data.date || "N/A"}\n\n` +
      `📝 ${desc}`;

    // Send to admin
    try {
      await client.messages.create({ from: fromWA, to: adminWA, body: message });
      await logNotification("whatsapp", "New Innovation Submitted", "Admin", ADMIN_WA_TO.value(), message, "delivered");
      logger.info("WhatsApp sent for innovation:", event.params.docId);
    } catch (err) {
      await logNotification("whatsapp", "New Innovation Submitted", "Admin", ADMIN_WA_TO.value(), message, "failed");
      logger.error("WhatsApp send failed:", err.message);
    }

    // Check notification rules for additional recipients
    try {
      const rulesSnap = await firestore.collection("notificationRules")
        .where("trigger", "==", "New Innovation Submitted")
        .where("active", "==", true)
        .get();

      for (const ruleDoc of rulesSnap.docs) {
        const rule = ruleDoc.data();
        if (rule.channel === "whatsapp" && rule.recipientContact) {
          try {
            await client.messages.create({
              from: fromWA,
              to: `whatsapp:${rule.recipientContact}`,
              body: message,
            });
            await logNotification("whatsapp", "New Innovation Submitted", rule.recipientName, rule.recipientContact, message, "delivered");
          } catch (err) {
            await logNotification("whatsapp", "New Innovation Submitted", rule.recipientName, rule.recipientContact, message, "failed");
            logger.error(`WhatsApp to ${rule.recipientContact} failed:`, err.message);
          }
        }
      }
    } catch (e) {
      logger.error("Error checking notification rules:", e.message);
    }
  }
);
