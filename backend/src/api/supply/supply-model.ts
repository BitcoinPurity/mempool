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
