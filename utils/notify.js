const User = require("../models/User");
const Notification = require("../models/Notification");
const PushToken = require("../models/PushToken");
const { getIO } = require("./socket");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const REFS = ["conversation", "deal", "transaction", "subject", "listing"];

async function sendPush(userId, { title, body, data }) {
  const tokens = await PushToken.find({ user: userId }).lean();
  if (!tokens.length) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    title,
    body,
    data,
    sound: "default",
    priority: "high",
  }));

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN)
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Expo push service returned ${res.status}`);

  // Tickets come back in the same order as the messages. Remove tokens of uninstalled apps.
  const { data: tickets = [] } = await res.json();
  const dead = [];
  tickets.forEach((t, i) => {
    if (t.status === "error" && t.details && t.details.error === "DeviceNotRegistered") {
      dead.push(tokens[i].token);
    }
  });
  if (dead.length) await PushToken.deleteMany({ token: { $in: dead } });
}

async function notifyOne(userId, p) {
  const fields = { title: p.title, body: p.body || "" };
  const refs = {};
  REFS.forEach((k) => {
    if (p[k]) refs[k] = p[k];
  });

  let doc;
  if (p.collapse && refs.conversation) {
    // One unread notification per conversation: update it instead of piling up new ones.
    doc = await Notification.findOneAndUpdate(
      { user: userId, type: p.type, isRead: false, conversation: refs.conversation },
      { $set: fields, $inc: { count: 1 } },
      { upsert: true, new: true }
    );
  } else {
    doc = await Notification.create({ user: userId, type: p.type, ...fields, ...refs });
  }

  const io = getIO();
  if (io) io.to(`user:${userId}`).emit("notification", doc);

  if (p.push !== false) {
    const data = { type: p.type, notificationId: String(doc._id) };
    Object.entries(refs).forEach(([k, v]) => {
      data[`${k}Id`] = String(v);
    });
    await sendPush(userId, { title: p.title, body: p.body || "", data });
  }
}

/** notify(userIdOrIds, { type, title, body, conversation?, deal?, transaction?, subject?, collapse?, push? }) */
function notify(userIds, payload) {
  const ids = [].concat(userIds).filter(Boolean);
  return Promise.allSettled(ids.map((id) => notifyOne(id, payload))).then((results) => {
    results.forEach((r) => {
      if (r.status === "rejected")
        console.error("[FairBloom] Notification failed:", r.reason && r.reason.message);
    });
  });
}

function notifyAdmins(payload) {
  return User.find({ role: "admin", isActive: true })
    .select("_id")
    .lean()
    .then((admins) =>
      notify(
        admins.map((a) => a._id),
        payload
      )
    )
    .catch((err) => console.error("[FairBloom] Admin notification failed:", err.message));
}

module.exports = { notify, notifyAdmins };
