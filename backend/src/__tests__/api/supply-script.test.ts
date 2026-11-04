import * as bitcoinjs from 'bitcoinjs-lib';
import { MAX_SCRIPT_SIZE, addressToScript, describeScript, isUnspendable, supplyNetwork } from '../../api/supply/supply-script';
import { BUCKET_LOWER_BOUNDS, MAX_SUPPLY_SATS, bucketIndex, issuedSupplyAt } from '../../api/supply/supply-model';
import { BLOCK1_PUBKEY, p2pkUncompressed } from './supply-test-utils';

const mainnet = supplyNetwork('mainnet');
const signet = supplyNetwork('signet');

describe('supply script descriptions and address round trips', () => {
  const vectors: [string, string, string][] = [
    ['p2pkh', '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
    ['v0_p2wpkh', '0014751e76e8199196d454941c45d1b3a323f1433bd6', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['v0_p2wsh', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
      'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'],
    ['v1_p2tr', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
    ['anchor', '51024e73', 'bc1pfeessrawgf'],
    ['p2pk', p2pkUncompressed().toString('hex'), BLOCK1_PUBKEY],
  ];

  test.each(vectors)('%s encodes and decodes', (type, scriptHex, address) => {
    const script = Buffer.from(scriptHex, 'hex');
    expect(describeScript(script, mainnet)).toEqual({ type, address });
    expect(addressToScript(address, mainnet)).toEqual(script);
  });

  test('P2SH matches bitcoinjs and uses the network version byte', () => {
    const script = Buffer.concat([Buffer.from('a914', 'hex'), Buffer.alloc(20, 7), Buffer.from('87', 'hex')]);
    const address = bitcoinjs.address.fromOutputScript(script, bitcoinjs.networks.bitcoin);
    expect(address.startsWith('3')).toBe(true);
    expect(describeScript(script, mainnet)).toEqual({ type: 'p2sh', address });
    expect(addressToScript(address, mainnet)).toEqual(script);
  });

  test('signet uses testnet prefixes and rejects mainnet addresses', () => {
    const script = Buffer.from('0014751e76e8199196d454941c45d1b3a323f1433bd6', 'hex');
    expect(describeScript(script, signet).address).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    expect(addressToScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', signet)).toEqual(script);
    expect(addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', signet)).toBeNull();
    expect(addressToScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', signet)).toBeNull();
  });

  test('scripts without addresses and invalid input', () => {
    expect(describeScript(Buffer.from('5121' + '02'.padEnd(66, '1') + '51ae', 'hex'), mainnet)).toEqual({ type: 'multisig', address: null });
    expect(describeScript(Buffer.from('0010' + '00'.repeat(16), 'hex'), mainnet)).toEqual({ type: 'nonstandard', address: null });
    expect(describeScript(Buffer.from('52020000', 'hex'), mainnet).type).toBe('unknown');
    expect(describeScript(Buffer.from('76a9', 'hex'), mainnet)).toEqual({ type: 'nonstandard', address: null });
    for (const bad of ['', 'not-an-address', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'x'.repeat(131)]) {
      expect(addressToScript(bad, mainnet)).toBeNull();
    }
  });

  test('unspendable outputs follow CScript::IsUnspendable', () => {
    expect(isUnspendable(Buffer.from('6a0401020304', 'hex'))).toBe(true);
    expect(isUnspendable(Buffer.alloc(MAX_SCRIPT_SIZE + 1, 0x51))).toBe(true);
    expect(isUnspendable(Buffer.alloc(MAX_SCRIPT_SIZE, 0x51))).toBe(false);
    expect(isUnspendable(Buffer.alloc(0))).toBe(false);
  });
});

describe('supply model', () => {
  test('balance ranges put exact bounds in the higher range', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(99_999)).toBe(0);
    expect(bucketIndex(100_000)).toBe(1);
    expect(bucketIndex(100_000_000)).toBe(4);
    expect(bucketIndex(10_000_000_000_000)).toBe(BUCKET_LOWER_BOUNDS.length - 1);
    expect(bucketIndex(MAX_SUPPLY_SATS)).toBe(BUCKET_LOWER_BOUNDS.length - 1);
  });

  test('issued supply follows the halving schedule', () => {
    expect(issuedSupplyAt(0)).toBe(5_000_000_000);
    expect(issuedSupplyAt(209_999)).toBe(210_000 * 5_000_000_000);
    expect(issuedSupplyAt(210_000)).toBe(210_000 * 5_000_000_000 + 2_500_000_000);
    expect(issuedSupplyAt(10_000_000)).toBe(2_099_999_997_690_000);
    expect(issuedSupplyAt(-1)).toBe(0);
  });
});
