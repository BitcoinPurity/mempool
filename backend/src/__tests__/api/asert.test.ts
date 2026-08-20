import {
  ASERT_HALF_LIFE,
  MAINNET_POW_LIMIT,
  POW_TARGET_SPACING,
  bitsToTarget,
  calculateAsert,
  difficultyChangeFromBits,
  getNextAsertBits,
  targetToBits,
} from '../../api/asert';

describe('ASERT aserti3-1d', () => {
  test('bitsToTarget / targetToBits round-trip for common compact values', () => {
    for (const bits of [0x1d00ffff, 0x1a00ffff, 0x1c0fffff, 0x17033d1c]) {
      const target = bitsToTarget(bits);
      expect(targetToBits(target)).toBe(bits);
    }
  });

  test('one half-life behind schedule doubles the target', () => {
    const ref = bitsToTarget(0x1a00ffff);
    const next = calculateAsert(
      ref,
      POW_TARGET_SPACING,
      ASERT_HALF_LIFE + POW_TARGET_SPACING,
      0,
      MAINNET_POW_LIMIT,
      ASERT_HALF_LIFE,
    );
    expect(next).toBe(ref * 2n);
  });

  test('one half-life ahead of schedule halves the target', () => {
    const ref = bitsToTarget(0x1a00ffff);
    const next = calculateAsert(
      ref,
      POW_TARGET_SPACING,
      POW_TARGET_SPACING - ASERT_HALF_LIFE,
      0,
      MAINNET_POW_LIMIT,
      ASERT_HALF_LIFE,
    );
    expect(next).toBe(ref / 2n);
  });

  test('on-schedule returns the same target', () => {
    const ref = bitsToTarget(0x1a00ffff);
    const next = calculateAsert(
      ref,
      POW_TARGET_SPACING,
      POW_TARGET_SPACING,
      0,
      MAINNET_POW_LIMIT,
      ASERT_HALF_LIFE,
    );
    expect(next).toBe(ref);
  });

  test('GetNextASERTWorkRequired matches on-schedule chain from anchor', () => {
    const anchorBits = 0x1a00ffff;
    const anchorHeight = 961632;
    const parentTime = 1_700_000_000;
    const spacing = POW_TARGET_SPACING;
    // tip at activation-1 = 961635, on schedule: 3 blocks after parent of anchor
    // height_diff from anchor: 961635 - 961632 = 3
    // time at tip: parentTime + spacing * (3 + 1) if on schedule from parent...
    // MakeAsertChain: first_height = anchor-1, t0 + i*spacing
    // blocks[0] height 961631 time t0
    // blocks[1] height 961632 time t0+600  <- anchor, parentTime = t0
    // blocks[4] height 961635 time t0+2400
    const t0 = parentTime;
    const tipHeight = 961635;
    const tipTime = t0 + (tipHeight - (anchorHeight - 1)) * spacing;
    const nextBits = getNextAsertBits(
      { height: anchorHeight, bits: anchorBits, parentTime: t0 },
      tipHeight,
      tipTime,
    );
    expect(nextBits).toBe(anchorBits);
  });

  test('difficultyChangeFromBits has no legacy ±75/×4 clamp', () => {
    // 8x easier target => -87.5% (would clamp to -75 under legacy DAA)
    expect(difficultyChangeFromBits(0x1d000100, 0x1d000800)).toBeCloseTo(-87.5, 5);
  });
});
