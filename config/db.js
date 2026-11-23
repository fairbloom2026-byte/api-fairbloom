const mongoose = require("mongoose");

/**
 * Listings posted before admin moderation existed have no reviewStatus. They were already
 * live, so mark them approved once. Safe to run on every connect (it only touches unset rows).
 */
async function backfillListingReview() {
  try {
    const { modifiedCount } = await mongoose.connection
      .collection("listings")
      .updateMany({ reviewStatus: { $exists: false } }, { $set: { reviewStatus: "approved" } });
    if (modifiedCount) {
      console.log(`[FairBloom] Marked ${modifiedCount} existing listing(s) as approved.`);
    }
  } catch (err) {
    console.error("[FairBloom] Listing review backfill failed:", err.message);
  }
  // Lazy require: the model and price index load only after mongoose is connected.
  await require("../utils/listingPriceCheck").recheckUnpricedPending();
}

const connectDB = async () => {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    console.error(
      "MONGO_URI is not defined. Copy .env.example to .env and fill in your connection string."
    );
    process.exit(1);
  }

  if (uri.startsWith("mongodb+srv://")) {
    console.warn(
      "[FairBloom] Warning: MONGO_URI uses the '+srv' format. " +
        "If you're having connection issues on this network, switch to the " +
        "legacy 'mongodb://' standard connection string (see .env.example)."
    );
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      family: 4,
    });

    console.log(`[FairBloom] MongoDB connected: ${conn.connection.host}`);
    await backfillListingReview();
    return conn;
  } catch (err) {
    console.error("[FairBloom] MongoDB connection error:", err.message);

    if (err.message.includes("querySrv") || err.message.includes("ENOTFOUND")) {
      console.error(
        "\nThis looks like a DNS SRV resolution failure. " +
          "Make sure MONGO_URI in your .env is the LEGACY standard connection " +
          "string (starts with 'mongodb://' and lists explicit hosts), " +
          "not the 'mongodb+srv://' shorthand.\n"
      );
    }

    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("[FairBloom] MongoDB disconnected.");
});

mongoose.connection.on("reconnected", () => {
  console.log("[FairBloom] MongoDB reconnected.");
});

// For serverless (Vercel): connect once per warm instance and reuse it across requests.
// Throws instead of exiting, so a failed attempt is retried on the next request.
let pending = null;
const ensureDB = () => {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!pending) {
    if (!process.env.MONGO_URI) return Promise.reject(new Error("MONGO_URI is not set"));
    pending = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, family: 4 })
      .then(backfillListingReview)
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
};

module.exports = connectDB;
module.exports.ensureDB = ensureDB;
