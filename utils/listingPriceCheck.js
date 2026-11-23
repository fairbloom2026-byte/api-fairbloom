const { getVwap } = require("./priceIndex");

// Same limit the sale check uses (utils/transactionService.js).
const deviationThreshold = () => Number(process.env.PRICE_DEVIATION_THRESHOLD_PERCENT) || 30;

/**
 * Compares a listing's price per dozen with the variety's current VWAP.
 * Returns { vwap, deviationPercent, threshold, flagged }. deviationPercent is signed
 * (positive = above market). A listing with no price, or a variety with no approved
 * trades yet, can't be compared and is never flagged.
 */
async function checkListingPrice(flowerVariety, price) {
  const threshold = deviationThreshold();
  if (price === null || price === undefined || !(Number(price) > 0)) {
    return { vwap: null, deviationPercent: null, threshold, flagged: false };
  }
  const row = await getVwap(flowerVariety);
  if (!row || !row.vwap) return { vwap: null, deviationPercent: null, threshold, flagged: false };

  const deviationPercent = Math.round(((Number(price) - row.vwap) / row.vwap) * 10000) / 100;
  return {
    vwap: row.vwap,
    deviationPercent,
    threshold,
    flagged: Math.abs(deviationPercent) > threshold,
  };
}

/** "35% above" / "20% below", for notification text. */
const describeDeviation = (deviationPercent) =>
  `${Math.abs(deviationPercent)}% ${deviationPercent > 0 ? "above" : "below"}`;

/**
 * Listings left "pending" by the earlier rule (every post needed approval) were never
 * price-checked, so they have no priceDeviationPercent field. Check them once: within range
 * they go live, too far off they stay in the review queue. Safe to run on every start.
 */
async function recheckUnpricedPending() {
  const Listing = require("../models/Listing");
  try {
    const rows = await Listing.find({
      reviewStatus: "pending",
      priceDeviationPercent: { $exists: false },
    });
    let released = 0;
    for (const listing of rows) {
      const check = await checkListingPrice(listing.flowerVariety, listing.pricePerUnit);
      listing.priceDeviationPercent = check.deviationPercent;
      listing.marketVwapAtCheck = check.vwap;
      if (!check.flagged) {
        listing.reviewStatus = "approved";
        released++;
      }
      await listing.save();
    }
    if (rows.length) {
      console.log(
        `[FairBloom] Price-checked ${rows.length} pending listing(s); ${released} went live.`
      );
    }
  } catch (err) {
    console.error("[FairBloom] Pending listing price re-check failed:", err.message);
  }
}

module.exports = {
  checkListingPrice,
  describeDeviation,
  deviationThreshold,
  recheckUnpricedPending,
};
