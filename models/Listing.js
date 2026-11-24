const mongoose = require("mongoose");

/**
 * A single model covers both:
 *  - sell-farmer posting flowers they have available
 *  - request-buyer posting what they need
 * This keeps browsing/search/filter logic unified (Functional
 * Requirements 4 & 5 in the manuscript).
 */
const listingSchema = new mongoose.Schema(
  {
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["sell", "request"], required: true },

    flowerVariety: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 }, // in dozens
    pricePerUnit: {
      type: Number,
      min: 0,
      default: null,
      required: function () {
        return this.type === "sell" && this.status === "active";
      },
      validate: {
        validator: function (value) {
          return this.type !== "sell" || this.status !== "active" || value >= 0.01;
        },
        message: "Asking price per dozen must be greater than 0",
      },
    },

    location: {
      type: String,
      enum: [
        "Beckel",
        "Bahong",
        "Ambiong",
        "Bineng",
        "Tublay",
        "Sablan",
        "Baguio City",
        "La Trinidad",
      ],
      required: true,
    },

    description: { type: String, trim: true, maxlength: 500 },
    image: { type: mongoose.Schema.Types.ObjectId, ref: "File", default: null }, // optional flower photo

    status: {
      type: String,
      enum: ["active", "fulfilled", "cancelled"],
      default: "active",
    },
  },
  { timestamps: true }
);

// Supports the "Search and Filter" requirement: by flower type, location, status
listingSchema.index({ flowerVariety: 1, location: 1, status: 1 });

module.exports = mongoose.model("Listing", listingSchema);
