/**
 * Bitcoin Purity aserti3-1d (24-hour half-life).
 * Port of bitcoinpurity CalculateASERT / GetNextASERTWorkRequired.
 * Spec lineage: https://upgradespecs.bitcoincashnode.org/2020-11-15-asert/
 */

export const ASERT_HALF_LIFE = 24 * 60 * 60; // aserti3-1d
export const POW_TARGET_SPACING = 600;
/** Enforcement-chain anchor height (BIP110 period start). */
export const MAINNET_ASERT_ANCHOR_HEIGHT = 961632;
/** Suggested default activation (must be > anchor); overridable via config. */
export const DEFAULT_PURITY_ACTIVATION_HEIGHT = 961636;
export const MAINNET_POW_LIMIT = BigInt('0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

export interface AsertAnchor {
  height: number;
  bits: number;
  parentTime: number;
}

export function bitsToTarget(bits: number): bigint {
  if (
    !Number.isInteger(bits) ||
    bits < 1 ||
    bits > 0x207fffff ||
    (bits & 0x00800000) !== 0 ||
    (bits & 0x007fffff) === 0
  ) {
    throw new Error('Invalid bits');
  }
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  if (exponent <= 3) {
    return mantissa >> BigInt(8 * (3 - exponent));
  }
  return mantissa << BigInt(8 * (exponent - 3));
}

/**
 * Compact target encoding (Bitcoin Core GetCompact, non-negative).
 */
export function targetToBits(target: bigint): number {
  if (target <= 0n) {
    throw new Error('Invalid target');
  }
  let size = Math.floor((target.toString(16).length + 1) / 2);
  let compact: bigint;
  if (size <= 3) {
    compact = target << BigInt(8 * (3 - size));
  } else {
    compact = target >> BigInt(8 * (size - 3));
  }
  // Sign bit in mantissa: shift up an extra byte
  if (compact & 0x00800000n) {
    compact >>= 8n;
    size += 1;
  }
  if (size > 0xff || compact > 0x007fffffn) {
    throw new Error('Target out of compact range');
  }
  return Number(compact) | (size << 24);
}

/**
 * Integer cubic approximation of ASERT (aserti3).
 * next_target ≈ refTarget * 2^((nTimeDiff - spacing*(nHeightDiff+1)) / halfLife)
 */
export function calculateAsert(
  refTarget: bigint,
  nPowTargetSpacing: number,
  nTimeDiff: number,
  nHeightDiff: number,
  powLimit: bigint,
  nHalfLife: number,
): bigint {
  if (refTarget <= 0n || refTarget > powLimit) {
    throw new Error('Invalid ref target');
  }
  if (nHeightDiff < 0) {
    throw new Error('Invalid height diff');
  }
  if (nHalfLife <= 0) {
    throw new Error('Invalid half-life');
  }

  // Truncating toward-zero division (matches C++ / on signed integers)
  const numerator = (BigInt(nTimeDiff) - BigInt(nPowTargetSpacing) * BigInt(nHeightDiff + 1)) * 65536n;
  const halfLife = BigInt(nHalfLife);
  const exponent = numerator >= 0n ? numerator / halfLife : -((-numerator) / halfLife);

  const shifts = exponent >> 16n;
  const frac = exponent & 0xffffn;

  const factor =
    65536n +
    ((195766423245049n * frac +
      971821376n * frac * frac +
      5127n * frac * frac * frac +
      (1n << 47n)) >>
      48n);

  let nextTarget = refTarget * factor;
  const shiftAmount = shifts - 16n;
  if (shiftAmount <= 0n) {
    nextTarget >>= -shiftAmount;
  } else {
    const shifted = nextTarget << shiftAmount;
    if ((shifted >> shiftAmount) !== nextTarget) {
      nextTarget = powLimit;
    } else {
      nextTarget = shifted;
    }
  }

  if (nextTarget === 0n) {
    nextTarget = 1n;
  } else if (nextTarget > powLimit) {
    nextTarget = powLimit;
  }
  return nextTarget;
}

export function getNextAsertTarget(
  anchor: AsertAnchor,
  prevHeight: number,
  prevTime: number,
  powLimit: bigint = MAINNET_POW_LIMIT,
  halfLife: number = ASERT_HALF_LIFE,
  spacing: number = POW_TARGET_SPACING,
): bigint {
  const refTarget = bitsToTarget(anchor.bits);
  const nTimeDiff = prevTime - anchor.parentTime;
  const nHeightDiff = prevHeight - anchor.height;
  return calculateAsert(refTarget, spacing, nTimeDiff, nHeightDiff, powLimit, halfLife);
}

export function getNextAsertBits(
  anchor: AsertAnchor,
  prevHeight: number,
  prevTime: number,
  powLimit: bigint = MAINNET_POW_LIMIT,
  halfLife: number = ASERT_HALF_LIFE,
  spacing: number = POW_TARGET_SPACING,
): number {
  return targetToBits(getNextAsertTarget(anchor, prevHeight, prevTime, powLimit, halfLife, spacing));
}

/**
 * Difficulty change percent from old nBits to a new target.
 * Positive => harder (lower target). No ±75%/×4 clamp (ASERT has none).
 */
export function difficultyChangeFromTarget(oldBits: number, newTarget: bigint): number {
  const oldTarget = bitsToTarget(oldBits);
  if (newTarget === 0n) {
    return 0;
  }
  // (oldTarget / newTarget - 1) * 100 with fixed-point scale
  const scaled = (oldTarget * 100000000n) / newTarget;
  return Number(scaled) / 1000000 - 100;
}

export function difficultyChangeFromBits(oldBits: number, newBits: number): number {
  return difficultyChangeFromTarget(oldBits, bitsToTarget(newBits));
}
