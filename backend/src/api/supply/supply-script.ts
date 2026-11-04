import { createHash } from 'crypto';
import * as bitcoinjs from 'bitcoinjs-lib';

/** Consensus MAX_SCRIPT_SIZE: larger outputs are never added to the UTXO set. */
export const MAX_SCRIPT_SIZE = 10000;
const OP_RETURN = 0x6a;
const OP_CHECKSIG = 0xac;
const OP_CHECKMULTISIG = 0xae;

/** Script type labels, aligned with BitcoinApi.translateScriptPubKeyType. */
export type SupplyScriptType = 'p2pk' | 'p2pkh' | 'p2sh' | 'v0_p2wpkh' | 'v0_p2wsh' | 'v1_p2tr' | 'anchor' |
  'unknown' | 'multisig' | 'nonstandard';

export interface ScriptDescription {
  type: SupplyScriptType;
  /** Address string usable by the frontend address route (pubkey hex for P2PK), or null. */
  address: string | null;
}

/** Mirrors CScript::IsUnspendable: such outputs never enter the UTXO set. */
export function isUnspendable(script: Buffer): boolean {
  return (script.length > 0 && script[0] === OP_RETURN) || script.length > MAX_SCRIPT_SIZE;
}

/** Aggregation key shared by bootstrap and incremental paths. */
export function scriptHash(script: Buffer): Buffer {
  return createHash('sha256').update(script).digest();
}

export function supplyNetwork(network: string): bitcoinjs.Network {
  switch (network) {
    case 'mainnet':
      return bitcoinjs.networks.bitcoin;
    case 'regtest':
      return bitcoinjs.networks.regtest;
    default:
      return bitcoinjs.networks.testnet;
  }
}

function witnessProgram(script: Buffer): { version: number, program: Buffer } | null {
  if (script.length < 4 || script.length > 42) {
    return null;
  }
  const opcode = script[0];
  if (opcode !== 0x00 && (opcode < 0x51 || opcode > 0x60)) {
    return null;
  }
  if (script[1] + 2 !== script.length) {
    return null;
  }
  return { version: opcode === 0x00 ? 0 : opcode - 0x50, program: script.subarray(2) };
}

function isPubkey(pubkey: Buffer): boolean {
  return (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) ||
    (pubkey.length === 65 && pubkey[0] === 0x04);
}

export function describeScript(script: Buffer, network: bitcoinjs.Network): ScriptDescription {
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 &&
      script[23] === 0x88 && script[24] === OP_CHECKSIG) {
    return { type: 'p2pkh', address: bitcoinjs.address.toBase58Check(script.subarray(3, 23), network.pubKeyHash) };
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { type: 'p2sh', address: bitcoinjs.address.toBase58Check(script.subarray(2, 22), network.scriptHash) };
  }
  if ((script.length === 35 || script.length === 67) && script[0] === script.length - 2 &&
      script[script.length - 1] === OP_CHECKSIG && isPubkey(script.subarray(1, script.length - 1))) {
    return { type: 'p2pk', address: script.subarray(1, script.length - 1).toString('hex') };
  }
  const witness = witnessProgram(script);
  if (witness) {
    const { version, program } = witness;
    if (version === 0) {
      if (program.length === 20) {
        return { type: 'v0_p2wpkh', address: bitcoinjs.address.toBech32(program, 0, network.bech32) };
      }
      if (program.length === 32) {
        return { type: 'v0_p2wsh', address: bitcoinjs.address.toBech32(program, 0, network.bech32) };
      }
      return { type: 'nonstandard', address: null };
    }
    const address = bitcoinjs.address.toBech32(program, version, network.bech32);
    if (version === 1 && program.length === 32) {
      return { type: 'v1_p2tr', address };
    }
    if (version === 1 && program.length === 2 && program[0] === 0x4e && program[1] === 0x73) {
      return { type: 'anchor', address };
    }
    return { type: 'unknown', address };
  }
  if (script.length >= 3 && script[script.length - 1] === OP_CHECKMULTISIG &&
      script[0] >= 0x51 && script[0] <= 0x60 && script[script.length - 2] >= 0x51 && script[script.length - 2] <= 0x60) {
    return { type: 'multisig', address: null };
  }
  return { type: 'nonstandard', address: null };
}

const PUBKEY_HEX = /^(?:0[23][0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/;

/**
 * Converts an address string (as used by the frontend address route) back to its scriptPubKey.
 * Returns null when the string is not a valid address for the given network.
 */
export function addressToScript(address: string, network: bitcoinjs.Network): Buffer | null {
  if (typeof address !== 'string' || address.length === 0 || address.length > 130) {
    return null;
  }
  if (PUBKEY_HEX.test(address)) {
    const pubkey = Buffer.from(address, 'hex');
    return Buffer.concat([Buffer.from([pubkey.length]), pubkey, Buffer.from([OP_CHECKSIG])]);
  }
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
    try {
      const { version, hash } = bitcoinjs.address.fromBase58Check(address);
      if (hash.length !== 20) {
        return null;
      }
      if (version === network.pubKeyHash) {
        return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, OP_CHECKSIG])]);
      }
      if (version === network.scriptHash) {
        return Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
      }
    } catch (e) {
      // fall through to bech32
    }
  }
  try {
    const { version, prefix, data } = bitcoinjs.address.fromBech32(address);
    if (prefix !== network.bech32 || version < 0 || version > 16 || data.length < 2 || data.length > 40) {
      return null;
    }
    if (version === 0 && data.length !== 20 && data.length !== 32) {
      return null;
    }
    return Buffer.concat([Buffer.from([version === 0 ? 0x00 : 0x50 + version, data.length]), data]);
  } catch (e) {
    return null;
  }
}
