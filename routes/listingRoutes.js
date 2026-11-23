const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const {
  createListing,
  getListings,
  getListingById,
  updateListing,
  deleteListing,
} = require("../controllers/listingController");
const { listingValidation } = require("../middleware/validators");
const { protect, authorize, optionalAuth } = require("../middleware/auth");
const requireApproved = require("../middleware/requireApproved");
const { uploadImage } = require("../middleware/upload");

// Per-user cap on photo uploads, so nobody can fill the database.
const imageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user._id),
  skip: (req) => !req.is("multipart/form-data"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "You're uploading photos too quickly. Please wait a few minutes." },
});

// Public, but a token lets owners see their own listings that are still awaiting review.
router.get("/", optionalAuth, getListings);
router.get("/:id", optionalAuth, getListingById);

// uploadImage runs BEFORE the validators so multipart form fields are parsed first.
router.post(
  "/",
  protect,
  authorize("farmer", "buyer"),
  requireApproved,
  imageLimiter,
  uploadImage("image"),
  listingValidation,
  createListing
);
router.patch(
  "/:id",
  protect,
  authorize("farmer", "buyer"),
  requireApproved,
  imageLimiter,
  uploadImage("image"),
  updateListing
);
router.delete("/:id", protect, authorize("farmer", "buyer"), requireApproved, deleteListing);

module.exports = router;
