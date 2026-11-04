import { createHash } from 'crypto';
import { decompressPubkey } from '../../utils/secp256k1-decompress';
import { SNAPSHOT_MAGIC, SNAPSHOT_VERSION } from '../../api/supply/utxo-snapshot';
import { IEsploraApi } from '../../api/bitcoin/esplora-api.interface';

/** Encoders mirroring Bitcoin Core's serialization, used to build synthetic UTXO snapshots. */

export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let n = value;
  for (let len = 0; ; len++) {
    bytes.push((n % 128) | (len ? 0x80 : 0x00));
    if (n <= 0x7f) {
      break;
    }
    n = Math.floor(n / 128) - 1;
  }
  return Buffer.from(bytes.reverse());
}

export function encodeCompactSize(value: number): Buffer {
  if (value < 253) {
    return Buffer.from([value]);
  }
  if (value <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 253;
    b.writeUInt16LE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 254;
  b.writeUInt32LE(value, 1);
  return b;
}

export function compressAmount(amount: number): number {
  if (amount === 0) {
    return 0;
  }
  let n = amount;
  let e = 0;
  while (n % 10 === 0 && e < 9) {
    n /= 10;
    e++;
  }
  if (e < 9) {
    const d = n % 10;
    n = Math.floor(n / 10);
    return 1 + (n * 9 + d - 1) * 10 + e;
  }
  return 1 + (n - 1) * 10 + 9;
}

/** Core's ScriptCompression serialization: VARINT(nSize) + payload. */
export function encodeScript(script: Buffer): Buffer {
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return Buffer.concat([encodeVarInt(0), script.subarray(3, 23)]);
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return Buffer.concat([encodeVarInt(1), script.subarray(2, 22)]);
  }
  if (script.length === 35 && script[0] === 33 && script[34] === 0xac && (script[1] === 2 || script[1] === 3)) {
    return Buffer.concat([encodeVarInt(script[1]), script.subarray(2, 34)]);
  }
  if (script.length === 67 && script[0] === 65 && script[66] === 0xac && script[1] === 4) {
    const x = script.subarray(2, 34);
    const parity = script[65] & 1;
    const check = decompressPubkey(Buffer.concat([Buffer.from([2 | parity]), x]));
    if (check && check.equals(script.subarray(1, 66))) {
      return Buffer.concat([encodeVarInt(4 | parity), x]);
    }
  }
  return Buffer.concat([encodeVarInt(script.length + 6), script]);
}

export interface TestCoin {
  vout: number;
  height: number;
  coinbase?: boolean;
  amount: number;
  script: Buffer;
}

export function encodeCoin(coin: TestCoin): Buffer {
  return Buffer.concat([
    encodeCompactSize(coin.vout),
    encodeVarInt(coin.height * 2 + (coin.coinbase ? 1 : 0)),
    encodeVarInt(compressAmount(coin.amount)),
    encodeScript(coin.script),
  ]);
}

export interface SnapshotOptions {
  magic?: Buffer;
  version?: number;
  networkMagic?: Buffer;
  baseHash?: string;
  coinsCount?: number;
  trailing?: Buffer;
}

export const TEST_BASE_HASH = '00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054';

/** Build a snapshot from groups of coins sharing a txid. */
export function buildSnapshot(groups: TestCoin[][], options: SnapshotOptions = {}): Buffer {
  const coins = groups.reduce((sum, group) => sum + group.length, 0);
  const header = Buffer.alloc(2 + 4 + 32 + 8);
  header.writeUInt16LE(options.version ?? SNAPSHOT_VERSION, 0);
  (options.networkMagic ?? Buffer.from('f9beb4d9', 'hex')).copy(header, 2);
  Buffer.from(options.baseHash ?? TEST_BASE_HASH, 'hex').reverse().copy(header, 6);
  header.writeBigUInt64LE(BigInt(options.coinsCount ?? coins), 38);
  const parts = [options.magic ?? SNAPSHOT_MAGIC, header];
  groups.forEach((group, index) => {
    parts.push(createHash('sha256').update(String(index)).digest());
    parts.push(encodeCompactSize(group.length));
    for (const coin of group) {
      parts.push(encodeCoin(coin));
    }
  });
  if (options.trailing) {
    parts.push(options.trailing);
  }
  return Buffer.concat(parts);
}

export const BLOCK1_PUBKEY = '0496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858ee';

export function p2pkh(byte: number): Buffer {
  return Buffer.concat([Buffer.from('76a914', 'hex'), Buffer.alloc(20, byte), Buffer.from('88ac', 'hex')]);
}

export function p2wpkh(byte: number): Buffer {
  return Buffer.concat([Buffer.from('0014', 'hex'), Buffer.alloc(20, byte)]);
}

export function p2pkUncompressed(): Buffer {
  return Buffer.concat([Buffer.from([65]), Buffer.from(BLOCK1_PUBKEY, 'hex'), Buffer.from([0xac])]);
}

export function testOutput(script: Buffer, value: number): IEsploraApi.Vout {
  return { scriptpubkey: script.toString('hex'), scriptpubkey_asm: '', scriptpubkey_type: '', value };
}

export function testTx(txid: string, inputs: (IEsploraApi.Vout | 'coinbase')[], outputs: IEsploraApi.Vout[]): IEsploraApi.Transaction {
  return {
    txid, version: 2, locktime: 0, size: 0, weight: 0, fee: 0, status: { confirmed: true },
    vin: inputs.map((input, index) => ({
      txid: input === 'coinbase' ? '' : `prev-${txid}-${index}`, vout: 0, is_coinbase: input === 'coinbase',
      scriptsig: '', scriptsig_asm: '', inner_redeemscript_asm: '', inner_witnessscript_asm: '', sequence: 0, witness: [],
      prevout: input === 'coinbase' ? null : input,
    })),
    vout: outputs,
  };
}
