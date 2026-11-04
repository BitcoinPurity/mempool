import { decompressPubkey } from '../../utils/secp256k1-decompress';
import {
  RAW_SCRIPT_KIND, SnapshotCoin, SnapshotFormatError, SnapshotReader, bufferSource, decompressAmount, decompressScriptKey,
  parseSnapshot,
} from '../../api/supply/utxo-snapshot';
import {
  BLOCK1_PUBKEY, TEST_BASE_HASH, buildSnapshot, compressAmount, encodeVarInt, p2pkUncompressed, p2pkh, p2wpkh,
} from './supply-test-utils';

function parse(data: Buffer, capacity?: number): { header: ReturnType<typeof parseSnapshot>, coins: (SnapshotCoin & { script: Buffer })[] } {
  const coins: (SnapshotCoin & { script: Buffer })[] = [];
  const header = parseSnapshot(new SnapshotReader(bufferSource(data), capacity), (coin) => {
    coins.push({ ...coin, key: Buffer.from(coin.key), script: decompressScriptKey(coin.key) });
  });
  return { header, coins };
}

describe('UTXO snapshot primitives', () => {
  test('decompresses Core CompressAmount vectors', () => {
    const vectors: [number, number][] = [
      [0, 0x0], [1, 0x1], [1_000_000, 0x7], [100_000_000, 0x9], [5_000_000_000, 0x32], [2_100_000_000_000_000, 0x1406f40],
    ];
    for (const [amount, compressed] of vectors) {
      expect(compressAmount(amount)).toBe(compressed);
      expect(decompressAmount(compressed)).toBe(amount);
    }
    for (const amount of [12345, 99_999_999, 123_456_789_012_345, 50_000_000_001]) {
      expect(decompressAmount(compressAmount(amount))).toBe(amount);
    }
  });

  test('reads Core VARINT encodings across continuation bytes', () => {
    for (const value of [0, 1, 127, 128, 255, 16383, 16384, 2 ** 32, 2 ** 40 + 7]) {
      const reader = new SnapshotReader(bufferSource(encodeVarInt(value)));
      expect(reader.readVarInt()).toBe(value);
      expect(reader.atEnd()).toBe(true);
    }
    expect(encodeVarInt(128)).toEqual(Buffer.from([0x80, 0x00]));
  });

  test('decompresses the block 1 coinbase public key', () => {
    const full = Buffer.from(BLOCK1_PUBKEY, 'hex');
    const compressed = Buffer.concat([Buffer.from([0x02 | (full[64] & 1)]), full.subarray(1, 33)]);
    expect(decompressPubkey(compressed)).toEqual(full);
    const flipped = Buffer.from(compressed);
    flipped[0] ^= 1;
    expect(decompressPubkey(flipped)?.subarray(0, 33)).toEqual(full.subarray(0, 33));
    expect(decompressPubkey(flipped)).not.toEqual(full);
    expect(decompressPubkey(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xff)]))).toBeNull();
  });
});

describe('UTXO snapshot parser', () => {
  const p2sh = Buffer.concat([Buffer.from('a914', 'hex'), Buffer.alloc(20, 0x33), Buffer.from('87', 'hex')]);
  const p2pkCompressed = Buffer.concat([Buffer.from([33, 0x03]), Buffer.alloc(32, 0x44), Buffer.from([0xac])]);
  const multisig = Buffer.from('5121' + '02'.padEnd(66, '1') + '51ae', 'hex');
  const groups = [
    [
      { vout: 0, height: 1, coinbase: true, amount: 5_000_000_000, script: p2pkUncompressed() },
    ],
    [
      { vout: 0, height: 700000, amount: 12345, script: p2pkh(0x11) },
      { vout: 3, height: 700000, amount: 0, script: p2wpkh(0x22) },
      { vout: 300, height: 700001, amount: 99_999_999, script: p2sh },
    ],
    [
      { vout: 1, height: 800000, amount: 1, script: p2pkCompressed },
      { vout: 2, height: 800000, amount: 546, script: multisig },
    ],
  ];

  test('parses header and every script compression type', () => {
    const { header, coins } = parse(buildSnapshot(groups));
    expect(header).toEqual({ version: 2, networkMagic: 'f9beb4d9', baseBlockHash: TEST_BASE_HASH, coinsCount: 6 });
    expect(coins.map((c) => c.key[0])).toEqual([4, 0, RAW_SCRIPT_KIND, 1, 3, RAW_SCRIPT_KIND]);
    expect(coins.map((c) => c.script)).toEqual(groups.flat().map((c) => c.script));
    expect(coins.map((c) => c.amount)).toEqual([5_000_000_000, 12345, 0, 99_999_999, 1, 546]);
    expect(coins[0]).toMatchObject({ height: 1, coinbase: true });
    expect(coins[3]).toMatchObject({ height: 700001, coinbase: false });
  });

  test('parses identically when reads straddle the internal buffer', () => {
    const big = Buffer.alloc(9000, 0x51);
    const data = buildSnapshot([[{ vout: 0, height: 5, amount: 7, script: big }], ...groups]);
    const small = parse(data, 1);
    expect(small.coins[0].script).toEqual(big);
    expect(small.coins.slice(1).map((c) => c.script)).toEqual(groups.flat().map((c) => c.script));
  });

  test('rejects malformed snapshots', () => {
    const valid = buildSnapshot(groups);
    expect(() => parse(buildSnapshot(groups, { magic: Buffer.from('utxo!') }))).toThrow(/magic/);
    expect(() => parse(buildSnapshot(groups, { version: 1 }))).toThrow(/version 1/);
    expect(() => parse(valid.subarray(0, valid.length - 3))).toThrow(SnapshotFormatError);
    expect(() => parse(buildSnapshot(groups, { coinsCount: 7 }))).toThrow(SnapshotFormatError);
    expect(() => parse(buildSnapshot(groups, { coinsCount: 5 }))).toThrow(/coin count|Trailing/);
    expect(() => parse(buildSnapshot(groups, { trailing: Buffer.from([0]) }))).toThrow(/Trailing/);
  });
});
