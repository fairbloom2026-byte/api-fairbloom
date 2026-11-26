const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const File = require("../models/File");
const Notification = require("../models/Notification");
const { getIO, isUserInRoom } = require("../utils/socket");
const { processImage } = require("../utils/imageService");
const { notify } = require("../utils/notify");

// Trading is farmer <-> buyer only: farmers can't buy from or message other farmers,
// and buyers can't message other buyers.
const TRADER_ROLES = ["farmer", "buyer"];
const SAME_ROLE_MESSAGE = "Farmers can only message buyers, and buyers can only message farmers";

/** True when the conversation pairs exactly one farmer with one buyer. */
async function isFarmerBuyerPair(conversation) {
  const users = await User.find({ _id: { $in: conversation.participants } }).select("role");
  const roles = users.map((u) => u.role).sort();
  return roles.length === 2 && roles[0] === "buyer" && roles[1] === "farmer";
}

/**
 * @route   POST /api/conversations
 * @desc    Body: { recipientId, listingId? }
 * @access  Private (approved users)
 */
const startConversation = async (req, res) => {
  const { recipientId, listingId } = req.body;

  if (!recipientId || !mongoose.isValidObjectId(recipientId)) {
    return res.status(400).json({ message: "A valid recipientId is required" });
  }
  if (recipientId === String(req.user._id)) {
    return res.status(400).json({ message: "You can't start a conversation with yourself" });
  }

  if (!TRADER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Only farmers and buyers can start conversations" });
  }

  try {
    const recipient = await User.findById(recipientId);
    if (
      !recipient ||
      !recipient.isActive ||
      !TRADER_ROLES.includes(recipient.role) ||
      recipient.verificationStatus !== "approved"
    ) {
      return res.status(404).json({ message: "That user isn't available to chat" });
    }
    if (recipient.role === req.user.role) {
      return res.status(403).json({ code: "SAME_ROLE", message: SAME_ROLE_MESSAGE });
    }

    let conversation = await Conversation.findOne({
      participants: { $all: [req.user._id, recipientId], $size: 2 },
    });

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [req.user._id, recipientId],
        relatedListing: listingId || null,
      });
    }

    await conversation.populate("participants", "name role farmLocation buyerCategory");

    res.status(201).json({ conversation });
  } catch (err) {
    console.error("[FairBloom] Start conversation error:", err.message);
    res.status(500).json({ message: "Server error starting conversation" });
  }
};

/**
 * @route   GET /api/conversations
 * @access  Private
 */
const getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({ participants: req.user._id })
      .populate("participants", "name role farmLocation buyerCategory")
      .populate("relatedListing", "flowerVariety type")
      .sort({ lastMessageAt: -1 });

    res.json({ conversations });
  } catch (err) {
    console.error("[FairBloom] Get conversations error:", err.message);
    res.status(500).json({ message: "Server error fetching conversations" });
  }
};

async function assertParticipant(conversationId, userId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return { error: 404, message: "Conversation not found" };

  const isParticipant = conversation.participants.some((p) => p.toString() === userId.toString());
  if (!isParticipant) return { error: 403, message: "You're not part of this conversation" };

  return { conversation };
}

/**
 * @route   GET /api/conversations/:id/messages
 * @access  Private (participants only)
 */
const getMessages = async (req, res) => {
  try {
    const { conversation, error, message } = await assertParticipant(req.params.id, req.user._id);
    if (error) return res.status(error).json({ message });

    const messages = await Message.find({ conversation: conversation._id })
      .populate("sender", "name role")
      .sort({ createdAt: 1 });

    // Opening the chat clears its notifications.
    Notification.updateMany(
      { user: req.user._id, conversation: conversation._id, isRead: false },
      { isRead: true, readAt: new Date() },
      { timestamps: false }
    )
      .exec()
      .catch(() => {});

    res.json({ messages });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ message: "Invalid conversation id" });
    }
    console.error("[FairBloom] Get messages error:", err.message);
    res.status(500).json({ message: "Server error fetching messages" });
  }
};

/**
 * @route   POST /api/conversations/:id/messages
 * @desc    JSON { content } for text, or multipart/form-data with an optional
 *          `content` caption and an `image` file. At least one is required.
 * @access  Private (approved participants only)
 */
const sendMessage = async (req, res) => {
  const content = typeof req.body.content === "string" ? req.body.content.trim() : "";

  if (!content && !req.file) {
    return res.status(400).json({ message: "Message content or an image is required" });
  }
  if (content.length > 1000) {
    return res.status(400).json({ message: "Message is too long (max 1000 characters)" });
  }

  try {
    const {
      conversation,
      error,
      message: guardMessage,
    } = await assertParticipant(req.params.id, req.user._id);
    if (error) return res.status(error).json({ message: guardMessage });

    // Older farmer-farmer / buyer-buyer chats (made before this rule) stay readable but closed.
    if (!(await isFarmerBuyerPair(conversation))) {
      return res.status(403).json({ code: "SAME_ROLE", message: SAME_ROLE_MESSAGE });
    }

    let fileDoc = null;
    if (req.file) {
      let processed;
      try {
        processed = await processImage(req.file.buffer, { maxSize: 1280, quality: 75 });
      } catch (imgErr) {
        return res.status(400).json({ message: imgErr.message });
      }
      fileDoc = await File.create({
        owner: req.user._id,
        kind: "chat",
        conversation: conversation._id,
        ...processed,
      });
    }

    let newMessage;
    try {
      newMessage = await Message.create({
        conversation: conversation._id,
        sender: req.user._id,
        content,
        image: fileDoc ? fileDoc._id : null,
      });
    } catch (msgErr) {
      if (fileDoc) await File.deleteOne({ _id: fileDoc._id });
      throw msgErr;
    }
    await newMessage.populate("sender", "name role");

    conversation.lastMessage = content || "[Photo]";
    conversation.lastMessageAt = new Date();
    await conversation.save();

    const io = getIO();
    if (io) io.to(conversation._id.toString()).emit("receive_message", newMessage);

    // Notify the other person, unless they're looking at this chat right now.
    const recipientId = conversation.participants.find((p) => String(p) !== String(req.user._id));
    if (recipientId && !isUserInRoom(recipientId, String(conversation._id))) {
      notify(recipientId, {
        type: "message",
        title: req.user.name,
        body: content ? "Sent you a message" : "Sent you a photo", // generic on purpose: push passes through Expo/Google
        conversation: conversation._id,
        collapse: true,
      });
    }

    res.status(201).json({ message: newMessage });
  } catch (err) {
    console.error("[FairBloom] Send message error:", err.message);
    res.status(500).json({ message: "Server error sending message" });
  }
};

module.exports = { startConversation, getConversations, getMessages, sendMessage };
