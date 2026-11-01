import {
  ASERT_HALF_LIFE,
  checkDifficultyBits,
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


// Established consensus fixtures: bitcoinpurity v1.1.0 src/test/pow_tests.cpp.
describe('Signet consensus fixtures', () => {
  const limit = BigInt('0x00000377ae000000000000000000000000000000000000000000000000000000');
  const ref = BigInt('0x0000010000000000000000000000000000000000000000000000000000000000');
  const fixtures: { vectors: { extraTime: number; target: string }[] } = require('../../__fixtures__/signet-asert.json');
  test.each(fixtures.vectors)('matches C++ integer reference $extraTime', ({ extraTime, target }) => {
    expect(calculateAsert(ref, 600, 3000 + extraTime, 4, limit, 86400)).toBe(BigInt('0x' + target));
  });
  test('matches selected-height C++ header fixture and its activation exception', () => {
    const bits = getNextAsertBits({ height: 318616, bits: 0x1d13c0c2, parentTime: 1787261860 },
      318620, 1787266302, limit);
    expect(bits).toBe(0x1d13fbb5);
    expect(checkDifficultyBits(0x1d13c0c2, bits, 318621, 318621, limit)).toBe(true);
    expect(checkDifficultyBits(0x1d13c0c2, bits, 318622, 318621, limit)).toBe(false);
  });
  test.each([327021, 327022, 327023])('acceptance at height %i follows CheckDifficultyBits', height => {
    const required = 0x1d154f9b;
    expect(checkDifficultyBits(required, required, height, 327022, limit)).toBe(true);
    expect(checkDifficultyBits(0x1d100000, required, height, 327022, limit)).toBe(height === 327022);
    expect(checkDifficultyBits(0x1d200000, required, height, 327022, limit)).toBe(false);
  });
  test.each([0, 0x01000001, 0x1d954f9b, 0x2100ffff, 0x1e040000])('rejects invalid activation bits %i', bits => {
    expect(checkDifficultyBits(bits, 0x1d154f9b, 327022, 327022, limit)).toBe(false);
  });
  test('round-trips Signet compact targets and clamps to its own powLimit', () => {
    for (const bits of [0x1d154f9b, 0x1e0377ae, 0x01010000, 0x02008000]) {
      expect(targetToBits(bitsToTarget(bits))).toBe(bits);
    }
    expect(calculateAsert(ref, 600, 30000000, 0, limit, 86400)).toBe(limit);
    expect(targetToBits(limit)).toBe(0x1e0377ae);
    expect(() => calculateAsert(ref, 600, 600, 0, MAINNET_POW_LIMIT, 86400)).toThrow();
  });
});


describe('official Purity Signet headers', () => {
  const { headers, anchorParentTime } = require('../../__fixtures__/purity-signet-headers.json');
  const limit = BigInt('0x00000377ae000000000000000000000000000000000000000000000000000000');
  const anchor = { height: 327017, bits: 0x1d154f9b, parentTime: anchorParentTime };
  test('headers link to the official activation block and commit to observed nBits', () => {
    const { Block } = require('bitcoinjs-lib');
    for (let i = 0; i < headers.length; i++) {
      const parsed = Block.fromHex(headers[i].header);
      expect(parsed.getId()).toBe(headers[i].hash);
      expect(parsed.bits).toBe(headers[i].bits);
      expect(parsed.timestamp).toBe(headers[i].time);
      if (i) expect(Buffer.from(parsed.prevHash).reverse().toString('hex')).toBe(headers[i - 1].hash);
    }
    expect(headers[5].hash).toBe('00000004b42cf68f94be9dd89b65e44cae31eee382137221b83b5b261d3e3c20');
  });
  test('327021 retains legacy bits; 327022 and 327023 match the official ASERT headers', () => {
    const parent = headers.find(b => b.height === 327021);
    const activation = headers.find(b => b.height === 327022);
    const next = headers.find(b => b.height === 327023);
    expect(parent.bits).toBe(headers[0].bits); // no legacy epoch boundary in this range
    const reference = getNextAsertBits(anchor, parent.height, parent.time, limit);
    expect(reference).toBe(activation.bits);
    expect(checkDifficultyBits(activation.bits, reference, 327022, 327022, limit)).toBe(true);
    expect(bitsToTarget(activation.bits)).toBeLessThanOrEqual(bitsToTarget(reference));
    expect(getNextAsertBits(anchor, activation.height, activation.time, limit)).toBe(next.bits);
    expect(difficultyChangeFromBits(activation.bits, next.bits)).not.toBe(0);
  });
});
