const mongoose = require("mongoose");

const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });

const notificationSchema = new mongoose.Schema(
  {
    user: { ...ref("User"), required: true },
    type: { type: String, required: true }, // e.g. "message", "deal_proposed", "verification_approved"
    title: { type: String, required: true },
    body: { type: String, default: "" },

    // What it's about, so the app can open the right screen
    conversation: ref("Conversation"),
    deal: ref("Deal"),
    transaction: ref("Transaction"),
    subject: ref("User"),

    count: { type: Number }, // how many messages were collapsed into this one (unset means 1)
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, updatedAt: -1 });
// Notifications clean themselves up after 90 days
notificationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("Notification", notificationSchema);
