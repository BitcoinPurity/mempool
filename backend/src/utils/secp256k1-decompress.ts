const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SQRT_EXPONENT = (P + 1n) / 4n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) {
      result = (result * base) % modulus;
    }
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/**
 * Decompress a 33-byte secp256k1 public key (0x02/0x03 prefix) to its 65-byte uncompressed form.
 * Returns null when the x coordinate is not on the curve.
 */
export function decompressPubkey(compressed: Buffer): Buffer | null {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    return null;
  }
  const x = BigInt('0x' + compressed.subarray(1).toString('hex'));
  if (x >= P) {
    return null;
  }
  const ySquared = (modPow(x, 3n, P) + 7n) % P;
  let y = modPow(ySquared, SQRT_EXPONENT, P);
  if ((y * y) % P !== ySquared) {
    return null;
  }
  if ((y & 1n) !== BigInt(compressed[0] & 1)) {
    y = P - y;
  }
  const out = Buffer.alloc(65);
  out[0] = 0x04;
  compressed.copy(out, 1, 1);
  Buffer.from(y.toString(16).padStart(64, '0'), 'hex').copy(out, 33);
  return out;
}
