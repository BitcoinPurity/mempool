import * as fs from 'fs';
import { decompressPubkey } from '../../utils/secp256k1-decompress';
import { MAX_SCRIPT_SIZE } from './supply-script';

/**
 * Reader for Bitcoin Core's `dumptxoutset` UTXO snapshot (format version 2, Core 28+), which
 * Purity 1.1.0 (Core 29.4 based) writes:
 *
 *   magic "utxo\xff" | uint16 version | 4-byte network magic | uint256 base blockhash | uint64 coins_count
 *   repeated: txid (32) | CompactSize n | n × (CompactSize vout | Coin)
 *   Coin = VARINT(height*2 + coinbase) | VARINT(CompressAmount(value)) | ScriptCompression
 */

export const SNAPSHOT_MAGIC = Buffer.from([0x75, 0x74, 0x78, 0x6f, 0xff]);
export const SNAPSHOT_VERSION = 2;
const MAX_COMPACT_SIZE = 0x02000000;
const SPECIAL_SCRIPTS = 6;
/** Key kind for scripts that ScriptCompression stores verbatim. */
export const RAW_SCRIPT_KIND = 6;

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

export interface ByteSource {
  /** Read up to `length` bytes into `buffer` at `offset`; return 0 at end of input. */
  read(buffer: Buffer, offset: number, length: number): number;
}

export function bufferSource(data: Buffer): ByteSource {
  let position = 0;
  return {
    read(buffer: Buffer, offset: number, length: number): number {
      const count = Math.min(length, data.length - position);
      data.copy(buffer, offset, position, position + count);
      position += count;
      return count;
    },
  };
}

export function fileSource(fd: number): ByteSource {
  return {
    read(buffer: Buffer, offset: number, length: number): number {
      return fs.readSync(fd, buffer, offset, length, null);
    },
  };
}

/** Synchronous buffered reader; views returned by readBytes are valid until the next read. */
export class SnapshotReader {
  private buffer: Buffer;
  private position = 0;
  private end = 0;
  private exhausted = false;

  constructor(private source: ByteSource, capacity = 8 * 1024 * 1024) {
    this.buffer = Buffer.allocUnsafe(Math.max(capacity, MAX_SCRIPT_SIZE * 2));
  }

  private ensure(length: number): void {
    if (this.end - this.position >= length) {
      return;
    }
    if (this.position > 0) {
      this.buffer.copy(this.buffer, 0, this.position, this.end);
      this.end -= this.position;
      this.position = 0;
    }
    while (this.end < length && !this.exhausted) {
      const read = this.source.read(this.buffer, this.end, this.buffer.length - this.end);
      if (read === 0) {
        this.exhausted = true;
      }
      this.end += read;
    }
    if (this.end - this.position < length) {
      throw new SnapshotFormatError('Unexpected end of UTXO snapshot');
    }
  }

  atEnd(): boolean {
    if (this.end > this.position) {
      return false;
    }
    if (!this.exhausted) {
      this.position = 0;
      this.end = this.source.read(this.buffer, 0, this.buffer.length);
      if (this.end === 0) {
        this.exhausted = true;
      }
    }
    return this.end === this.position;
  }

  readU8(): number {
    this.ensure(1);
    return this.buffer[this.position++];
  }

  readBytes(length: number): Buffer {
    this.ensure(length);
    const view = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return view;
  }

  readU16LE(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16LE(this.position);
    this.position += 2;
    return value;
  }

  readU32LE(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  readU64LE(): number {
    this.ensure(8);
    const value = this.buffer.readBigUInt64LE(this.position);
    this.position += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SnapshotFormatError('64-bit value out of range');
    }
    return Number(value);
  }

  /** Bitcoin CompactSize with Core's canonical-encoding and MAX_SIZE checks. */
  readCompactSize(): number {
    const first = this.readU8();
    let value: number;
    if (first < 253) {
      value = first;
    } else if (first === 253) {
      value = this.readU16LE();
      if (value < 253) {
        throw new SnapshotFormatError('Non-canonical CompactSize');
      }
    } else if (first === 254) {
      value = this.readU32LE();
      if (value < 0x10000) {
        throw new SnapshotFormatError('Non-canonical CompactSize');
      }
    } else {
      value = this.readU64LE();
      if (value < 0x100000000) {
        throw new SnapshotFormatError('Non-canonical CompactSize');
      }
    }
    if (value > MAX_COMPACT_SIZE) {
      throw new SnapshotFormatError('CompactSize exceeds MAX_SIZE');
    }
    return value;
  }

  /** Core's VARINT (MSB base-128 with an offset per continuation byte). */
  readVarInt(): number {
    let value = 0;
    for (;;) {
      const byte = this.readU8();
      if (value > Math.floor((Number.MAX_SAFE_INTEGER - 0x7f) / 128)) {
        throw new SnapshotFormatError('VARINT out of range');
      }
      value = value * 128 + (byte & 0x7f);
      if (byte & 0x80) {
        value++;
      } else {
        return value;
      }
    }
  }
}

/** Inverse of Core's CompressAmount. */
export function decompressAmount(compressed: number): number {
  if (compressed === 0) {
    return 0;
  }
  let x = compressed - 1;
  let exponent = x % 10;
  x = Math.floor(x / 10);
  let amount: number;
  if (exponent < 9) {
    const digit = (x % 9) + 1;
    x = Math.floor(x / 9);
    amount = x * 10 + digit;
  } else {
    amount = x + 1;
  }
  while (exponent > 0) {
    amount *= 10;
    exponent--;
  }
  return amount;
}

export interface SnapshotHeader {
  version: number;
  networkMagic: string;
  /** Display (RPC) byte order. */
  baseBlockHash: string;
  coinsCount: number;
}

export interface SnapshotCoin {
  height: number;
  coinbase: boolean;
  amount: number;
  /**
   * Canonical compressed script key: [kind] + payload, where kind is the ScriptCompression special
   * type (0-5) or RAW_SCRIPT_KIND followed by the raw script. A view, valid only during the callback.
   */
  key: Buffer;
}

export function readSnapshotHeader(reader: SnapshotReader): SnapshotHeader {
  const magic = reader.readBytes(SNAPSHOT_MAGIC.length);
  if (!magic.equals(SNAPSHOT_MAGIC)) {
    throw new SnapshotFormatError('Not a UTXO snapshot (bad magic bytes)');
  }
  const version = reader.readU16LE();
  if (version !== SNAPSHOT_VERSION) {
    throw new SnapshotFormatError(`Unsupported UTXO snapshot version ${version}`);
  }
  const networkMagic = reader.readBytes(4).toString('hex');
  const baseBlockHash = Buffer.from(reader.readBytes(32)).reverse().toString('hex');
  const coinsCount = reader.readU64LE();
  return { version, networkMagic, baseBlockHash, coinsCount };
}

/** Stream every coin in the snapshot to `onCoin`, validating structure and the declared count. */
export function parseSnapshot(reader: SnapshotReader, onCoin: (coin: SnapshotCoin) => void): SnapshotHeader {
  const header = readSnapshotHeader(reader);
  let remaining = header.coinsCount;
  let keyBuffer = Buffer.allocUnsafe(MAX_SCRIPT_SIZE + 1);
  while (remaining > 0) {
    reader.readBytes(32); // txid
    const count = reader.readCompactSize();
    if (count === 0 || count > remaining) {
      throw new SnapshotFormatError('Invalid coin count for transaction in UTXO snapshot');
    }
    for (let i = 0; i < count; i++) {
      reader.readCompactSize(); // vout
      const code = reader.readVarInt();
      const amount = decompressAmount(reader.readVarInt());
      const size = reader.readVarInt();
      let kind: number;
      let payloadLength: number;
      if (size < SPECIAL_SCRIPTS) {
        kind = size;
        payloadLength = size < 2 ? 20 : 32;
      } else {
        kind = RAW_SCRIPT_KIND;
        payloadLength = size - SPECIAL_SCRIPTS;
        if (payloadLength > MAX_SCRIPT_SIZE) {
          throw new SnapshotFormatError('Oversized script in UTXO snapshot');
        }
      }
      if (keyBuffer.length < payloadLength + 1) {
        keyBuffer = Buffer.allocUnsafe(payloadLength + 1);
      }
      keyBuffer[0] = kind;
      reader.readBytes(payloadLength).copy(keyBuffer, 1);
      onCoin({
        height: Math.floor(code / 2),
        coinbase: (code & 1) === 1,
        amount,
        key: keyBuffer.subarray(0, payloadLength + 1),
      });
    }
    remaining -= count;
  }
  if (!reader.atEnd()) {
    throw new SnapshotFormatError('Trailing data after UTXO snapshot coins');
  }
  return header;
}

/** Rebuild the full scriptPubKey from a compressed key (Core's DecompressScript). */
export function decompressScriptKey(key: Buffer): Buffer {
  const kind = key[0];
  const payload = key.subarray(1);
  switch (kind) {
    case 0:
      return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), payload, Buffer.from([0x88, 0xac])]);
    case 1:
      return Buffer.concat([Buffer.from([0xa9, 0x14]), payload, Buffer.from([0x87])]);
    case 2:
    case 3:
      return Buffer.concat([Buffer.from([0x21, kind]), payload, Buffer.from([0xac])]);
    case 4:
    case 5: {
      const pubkey = decompressPubkey(Buffer.concat([Buffer.from([kind - 2]), payload]));
      if (!pubkey) {
        throw new SnapshotFormatError('Invalid compressed public key in UTXO snapshot');
      }
      return Buffer.concat([Buffer.from([0x41]), pubkey, Buffer.from([0xac])]);
    }
    case RAW_SCRIPT_KIND:
      return Buffer.from(payload);
    default:
      throw new SnapshotFormatError(`Unknown script key kind ${kind}`);
  }
}
