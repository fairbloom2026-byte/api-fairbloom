const mongoose = require("mongoose");
const { validationResult } = require("express-validator");
const Listing = require("../models/Listing");
const File = require("../models/File");
const escapeRegex = require("../utils/escapeRegex");
const { processImage } = require("../utils/imageService");
const { getVwapMap } = require("../utils/priceIndex");
const { DEFAULT_WINDOW_DAYS } = require("../utils/vwap");
const { notifyAdmins } = require("../utils/notify");
const { checkListingPrice, describeDeviation } = require("../utils/listingPriceCheck");

const isLive = (listing) => !["pending", "rejected"].includes(listing.reviewStatus);

/** Tells admins a listing was held back because its price is far from the market. */
const announceFlagged = (listing, poster) =>
  notifyAdmins({
    type: "listing_pending",
    title: "Listing flagged for price review",
    body: `${poster.name} (${poster.role}) listed ${listing.flowerVariety} at ₱${listing.pricePerUnit}/dozen, ${describeDeviation(listing.priceDeviationPercent)} the market price (₱${listing.marketVwapAtCheck})`,
    listing: listing._id,
  });

/**
 * Runs the price check and sets the listing's review state: flagged ("pending") when the
 * price is too far from the VWAP, otherwise live ("approved"). Returns the check result.
 */
async function applyPriceCheck(listing) {
  const check = await checkListingPrice(listing.flowerVariety, listing.pricePerUnit);
  listing.priceDeviationPercent = check.deviationPercent;
  listing.marketVwapAtCheck = check.vwap;
  listing.reviewStatus = check.flagged ? "pending" : "approved";
  listing.reviewNote = undefined;
  listing.reviewedBy = null;
  listing.reviewedAt = null;
  return check;
}

const flaggedMessage = (check) =>
  `Your price is ${describeDeviation(check.deviationPercent)} the market price (₱${check.vwap} per dozen), so an admin will review this listing before it goes live.`;

// Allow-list: only these sort keys are accepted from the query string.
const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  price_asc: { pricePerUnit: 1, createdAt: -1 },
  price_desc: { pricePerUnit: -1, createdAt: -1 },
  quantity_asc: { quantity: 1, createdAt: -1 },
  quantity_desc: { quantity: -1, createdAt: -1 },
};

const imageUrlFor = (image) => (image ? `/api/files/listing/${image}` : null);

// Works for both mongoose documents and lean objects.
const shape = (listing) => {
  const o = typeof listing.toObject === "function" ? listing.toObject() : listing;
  return { ...o, imageUrl: imageUrlFor(o.image) };
};

// Form fields arrive as strings; an empty price means "no asking price".
const parsePrice = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

/** Adds the current index price (and how the asking price compares) to plain listing objects. */
async function attachMarketPrice(listings) {
  const map = await getVwapMap(DEFAULT_WINDOW_DAYS);

  return listings.map((l) => {
    const row = map.get(String(l.flowerVariety).toLowerCase());
    const vwap = row ? row.vwap : null;

    let priceVsMarketPercent = null;
    if (vwap && l.pricePerUnit != null) {
      priceVsMarketPercent = Math.round(((l.pricePerUnit - vwap) / vwap) * 1000) / 10;
    }

    return {
      ...l,
      imageUrl: imageUrlFor(l.image),
      marketPrice: row
        ? { vwap, windowDays: DEFAULT_WINDOW_DAYS, transactionCount: row.transactionCount }
        : null,
      priceVsMarketPercent,
    };
  });
}

/**
 * @route   POST /api/listings   (JSON, or multipart/form-data with an optional `image`)
 * @access  Private (approved farmer, buyer). Only farmers may attach a photo.
 */
const createListing = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { type, flowerVariety, quantity, pricePerUnit, location, description } = req.body;

  const expectedType = req.user.role === "farmer" ? "sell" : "request";
  if (type !== expectedType) {
    return res.status(403).json({
      message: `As a ${req.user.role}, you can only create '${expectedType}' listings`,
    });
  }
  if (req.file && req.user.role !== "farmer") {
    return res.status(403).json({ message: "Only farmers can attach a photo to a listing" });
  }

  // Validate and shrink the image BEFORE creating anything.
  let processed = null;
  if (req.file) {
    try {
      processed = await processImage(req.file.buffer, { maxSize: 1280, quality: 78 });
    } catch (imgErr) {
      return res.status(400).json({ message: imgErr.message });
    }
  }

  let fileId = null;
  try {
    if (processed) {
      fileId = new mongoose.Types.ObjectId();
      await File.create({ _id: fileId, owner: req.user._id, kind: "listing", ...processed });
    }

    const listing = new Listing({
      postedBy: req.user._id,
      type,
      flowerVariety,
      quantity,
      pricePerUnit: parsePrice(pricePerUnit),
      location,
      description,
      image: fileId,
    });
    const check = await applyPriceCheck(listing);
    await listing.save();

    if (check.flagged) announceFlagged(listing, req.user);

    res.status(201).json({
      listing: shape(listing),
      priceCheck: check,
      message: check.flagged ? flaggedMessage(check) : "Your listing is live.",
    });
  } catch (err) {
    if (fileId) await File.deleteOne({ _id: fileId }).catch(() => {}); // don't leave an orphaned photo
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    console.error("[FairBloom] Create listing error:", err.message);
    res.status(500).json({ message: "Server error creating listing" });
  }
};

/**
 * @route   GET /api/listings
 * @desc    Query: type, flowerVariety, location, status, sort, page, limit.
 *          Listings flagged by the price check (pending) or rejected are left out. With mine=true (signed in), returns the
 *          caller's own listings in every review state; reviewStatus then narrows them.
 * @access  Public (mine=true needs a token)
 */
const getListings = async (req, res) => {
  try {
    const { type, flowerVariety, location, status = "active", sort = "newest" } = req.query;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const mine = req.query.mine === "true";

    if (mine && !req.user) {
      return res.status(401).json({ message: "Sign in to see your own listings" });
    }

    const filter = {};
    if (mine) {
      filter.postedBy = req.user._id;
      const { reviewStatus } = req.query;
      if (reviewStatus === "approved") Object.assign(filter, Listing.LIVE_FILTER);
      else if (["pending", "rejected"].includes(reviewStatus)) filter.reviewStatus = reviewStatus;
    } else {
      Object.assign(filter, Listing.LIVE_FILTER);
    }
    if (type) filter.type = String(type);
    if (location) filter.location = String(location);
    if (status) filter.status = String(status);
    if (flowerVariety) filter.flowerVariety = { $regex: escapeRegex(flowerVariety), $options: "i" };

    const sortKey = Object.prototype.hasOwnProperty.call(SORTS, sort) ? sort : "newest";
    if (sortKey === "price_asc" || sortKey === "price_desc") {
      filter.pricePerUnit = { $ne: null };
    }

    const [rows, total] = await Promise.all([
      Listing.find(filter)
        .populate("postedBy", "name role farmLocation buyerCategory businessLocation")
        .sort(SORTS[sortKey])
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Listing.countDocuments(filter),
    ]);

    const listings = await attachMarketPrice(rows);

    res.json({ listings, pagination: { total, page, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error("[FairBloom] Get listings error:", err.message);
    res.status(500).json({ message: "Server error fetching listings" });
  }
};

/**
 * @route   GET /api/listings/:id
 * @access  Public. A listing not yet approved is visible only to its poster and admins.
 */
const getListingById = async (req, res) => {
  try {
    const row = await Listing.findById(req.params.id)
      .populate("postedBy", "name role farmLocation buyerCategory businessLocation phone")
      .lean();

    if (!row) return res.status(404).json({ message: "Listing not found" });

    if (!isLive(row)) {
      const viewer = req.user;
      const isOwner = viewer && row.postedBy && String(row.postedBy._id) === String(viewer._id);
      if (!isOwner && viewer?.role !== "admin") {
        return res.status(404).json({ message: "Listing not found" });
      }
    }

    const [listing] = await attachMarketPrice([row]);
    res.json({ listing });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid listing id" });
    console.error("[FairBloom] Get listing error:", err.message);
    res.status(500).json({ message: "Server error fetching listing" });
  }
};

/**
 * @route   PATCH /api/listings/:id   (JSON, or multipart/form-data)
 * @desc    Editable: quantity, pricePerUnit, description, status.
 *          Photo: send a new `image` to replace it, or `removeImage=true` to remove it.
 * @access  Private (owner only)
 */
const updateListing = async (req, res) => {
  let newFileId = null;
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });

    if (listing.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only edit your own listings" });
    }
    if (req.file && req.user.role !== "farmer") {
      return res.status(403).json({ message: "Only farmers can attach a photo to a listing" });
    }

    ["quantity", "pricePerUnit", "description", "status"].forEach((field) => {
      if (req.body[field] === undefined) return;
      listing[field] = field === "pricePerUnit" ? parsePrice(req.body[field]) : req.body[field];
    });

    const oldImage = listing.image;

    if (req.file) {
      let processed;
      try {
        processed = await processImage(req.file.buffer, { maxSize: 1280, quality: 78 });
      } catch (imgErr) {
        return res.status(400).json({ message: imgErr.message });
      }
      newFileId = new mongoose.Types.ObjectId();
      await File.create({ _id: newFileId, owner: req.user._id, kind: "listing", ...processed });
      listing.image = newFileId;
    } else if (req.body.removeImage === true || req.body.removeImage === "true") {
      listing.image = null;
    }

    // Re-run the price check when the price changes, or when a rejected listing is edited
    // (that's how it gets resubmitted). Within range it goes live; too far off, it's flagged.
    // Other edits (photo, description, quantity, status) never need admin review.
    const edited = ["description", "pricePerUnit", "image", "quantity"].some((f) =>
      listing.isModified(f)
    );
    const recheck =
      listing.status === "active" &&
      (listing.isModified("pricePerUnit") || (listing.reviewStatus === "rejected" && edited));
    const wasFlagged = listing.reviewStatus === "pending";
    const check = recheck ? await applyPriceCheck(listing) : null;

    await listing.save();

    // Tell admins only when it newly lands in the queue.
    if (check?.flagged && !wasFlagged) announceFlagged(listing, req.user);

    // Only delete the previous photo after the new state is safely saved.
    if (oldImage && String(oldImage) !== String(listing.image)) {
      await File.deleteOne({ _id: oldImage }).catch(() => {});
    }

    res.json({
      listing: shape(listing),
      ...(check ? { priceCheck: check } : {}),
      ...(check?.flagged ? { message: flaggedMessage(check) } : {}),
    });
  } catch (err) {
    if (newFileId) await File.deleteOne({ _id: newFileId }).catch(() => {});
    if (err.name === "ValidationError") return res.status(400).json({ message: err.message });
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid listing id" });
    console.error("[FairBloom] Update listing error:", err.message);
    res.status(500).json({ message: "Server error updating listing" });
  }
};

/**
 * @route   DELETE /api/listings/:id
 * @access  Private (owner only)
 */
const deleteListing = async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ message: "Listing not found" });

    if (listing.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "You can only delete your own listings" });
    }

    const imageId = listing.image;
    await listing.deleteOne();
    if (imageId) await File.deleteOne({ _id: imageId }).catch(() => {});

    res.json({ message: "Listing deleted" });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ message: "Invalid listing id" });
    console.error("[FairBloom] Delete listing error:", err.message);
    res.status(500).json({ message: "Server error deleting listing" });
  }
};

module.exports = { createListing, getListings, getListingById, updateListing, deleteListing };
