export const COIN = 100_000_000;
export const MAX_SUPPLY_SATS = 21_000_000 * COIN;
const HALVING_INTERVAL = 210_000;
const INITIAL_SUBSIDY = 50 * COIN;

/**
 * Balance range lower bounds in satoshis: [0, 0.001), [0.001, 0.01), ... [10k, 100k), [100k, ∞) BTC.
 * A balance equal to a bound belongs to the higher range.
 */
export const BUCKET_LOWER_BOUNDS: readonly number[] = Object.freeze([
  0, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000,
  100_000_000_000, 1_000_000_000_000, 10_000_000_000_000,
]);

export interface BucketTotals {
  bucket: number;
  minSats: number;
  maxSats: number | null;
  scriptCount: number;
  amount: number;
}

export function bucketIndex(balance: number): number {
  let index = 0;
  while (index + 1 < BUCKET_LOWER_BOUNDS.length && balance >= BUCKET_LOWER_BOUNDS[index + 1]) {
    index++;
  }
  return index;
}

export function emptyBuckets(): BucketTotals[] {
  return BUCKET_LOWER_BOUNDS.map((minSats, bucket) => ({
    bucket,
    minSats,
    maxSats: bucket + 1 < BUCKET_LOWER_BOUNDS.length ? BUCKET_LOWER_BOUNDS[bucket + 1] : null,
    scriptCount: 0,
    amount: 0,
  }));
}

/** Rank tier upper bounds for the holder concentration chart: top 1–10, 11–100, 101–1,000, 1,001–10,000. */
export const TIER_UPPER_RANKS: readonly number[] = Object.freeze([10, 100, 1000, 10000]);

export interface HolderTier {
  fromRank: number;
  /** Inclusive; null for the tier of every script ranked below the last bound. */
  toRank: number | null;
  scriptCount: number;
  amount: number;
}

/**
 * Split the supply into rank tiers. `topBalances` is the top `topN` balances in rank order (balance DESC);
 * tiers above `topN` are cut at it, and everything below falls into the final open tier.
 * Zero balances are not counted as holders.
 */
export function holderTiers(topBalances: readonly number[], topN: number, totalAmount: number, nonZeroScriptCount: number): HolderTier[] {
  const bounds = TIER_UPPER_RANKS.filter((rank) => rank < topN).concat(topN);
  const tiers: HolderTier[] = [];
  let from = 0;
  let countedScripts = 0;
  let countedAmount = 0;
  for (const bound of bounds) {
    let scriptCount = 0;
    let amount = 0;
    for (const balance of topBalances.slice(from, bound)) {
      if (balance > 0) {
        scriptCount++;
        amount += balance;
      }
    }
    tiers.push({ fromRank: from + 1, toRank: bound, scriptCount, amount });
    countedScripts += scriptCount;
    countedAmount += amount;
    from = bound;
  }
  tiers.push({
    fromRank: topN + 1,
    toRank: null,
    scriptCount: Math.max(0, nonZeroScriptCount - countedScripts),
    amount: Math.max(0, totalAmount - countedAmount),
  });
  return tiers;
}

/** Total subsidy issued by the schedule for blocks 0..height inclusive (includes the genesis output). */
export function issuedSupplyAt(height: number): number {
  if (!Number.isSafeInteger(height) || height < 0) {
    return 0;
  }
  let issued = 0;
  let remaining = height + 1;
  for (let era = 0; remaining > 0 && era < 64; era++) {
    const blocks = Math.min(remaining, HALVING_INTERVAL);
    const subsidy = Math.floor(INITIAL_SUBSIDY / 2 ** era);
    if (subsidy === 0) {
      break;
    }
    issued += blocks * subsidy;
    remaining -= blocks;
  }
  return issued;
}
