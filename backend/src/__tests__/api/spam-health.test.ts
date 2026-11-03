import { Common } from '../../api/common';
import Audit from '../../api/audit';
import { TransactionExtended, TransactionFlags } from '../../mempool.interfaces';

const push = (length: number, byte = 'ab', encoding = 'auto'): string => {
  const prefix = encoding === 'p2' ? '4d' + Buffer.from([length & 255, length >> 8]).toString('hex')
    : encoding === 'p4' ? '4e' + Buffer.from([length & 255, length >> 8, 0, 0]).toString('hex')
    : length <= 75 ? length.toString(16).padStart(2, '0') : '4c' + length.toString(16).padStart(2, '0');
  return prefix + byte.repeat(length);
};
const output = (address = 'B', script = '0014' + '11'.repeat(20), type = 'v0_p2wpkh') => ({
  scriptpubkey: script, scriptpubkey_type: type, scriptpubkey_address: address, value: 10000,
});
const opReturn = (data = '') => ({ scriptpubkey: '6a' + data, scriptpubkey_type: 'op_return', value: 0 });
const input = (address = 'A') => ({
  scriptsig: '', scriptsig_asm: '', sequence: 0xffffffff, prevout: output(address),
});
const tx = (vout: any[] = [output()], vin: any[] = [input()]): TransactionExtended => ({
  txid: 'test', version: 2, locktime: 0, weight: 800, size: 200, fee: 1000,
  vin, vout, status: { confirmed: false },
} as TransactionExtended);
const isSpam = (transaction: TransactionExtended): boolean => {
  Common.classifyTransaction(transaction);
  return transaction.spam === true;
};
const control = 'c0' + '11'.repeat(32);
const taproot = (script: string, annex?: string) => ({
  ...input(), prevout: output('A', '5120' + '11'.repeat(32), 'v1_p2tr'),
  witness: ['ab'.repeat(64), script, control, ...(annex ? [annex] : [])],
});

describe('OP_RETURN spam policy', () => {
  test.each([0, 1, 75, 76, 80])('allows one %i-byte payload', length => {
    const transaction = tx([output(), opReturn(push(length))]);
    expect(isSpam(transaction)).toBe(false);
    expect(BigInt(transaction.flags!) & TransactionFlags.op_return).not.toBe(0n);
  });
  test.each(['auto', 'p2', 'p4'])('counts payload rather than %s length prefixes', encoding => {
    expect(isSpam(tx([output(), opReturn(push(80, 'ab', encoding))]))).toBe(false);
    expect(isSpam(tx([output(), opReturn(push(81, 'ab', encoding))]))).toBe(true);
  });
  test('sums multiple pushes within one OP_RETURN output', () => {
    expect(isSpam(tx([output(), opReturn(push(40) + push(40))]))).toBe(false);
    expect(isSpam(tx([output(), opReturn(push(40) + push(41))]))).toBe(true);
  });
  test('counts small integer pushes as payload bytes', () => {
    expect(isSpam(tx([output(), opReturn(push(80) + '51')]))).toBe(true);
  });
  test('rejects two OP_RETURN outputs even with empty payloads', () => {
    expect(isSpam(tx([output(), opReturn(), opReturn()]))).toBe(true);
  });
  test('allows self-transfers and address reuse with a normal OP_RETURN', () => {
    expect(isSpam(tx([output('A'), opReturn()], [input('A')]))).toBe(false);
    expect(isSpam(tx([output('B'), output('A'), output('A'), opReturn()], [input('A'), input('B')]))).toBe(false);
    expect(isSpam(tx([output('B'), output('A'), opReturn()], [input('A')]))).toBe(false);
    expect(isSpam(tx([output('A'), opReturn()], [input('A'), input('B')]))).toBe(false);
    expect(isSpam(tx([output('A')], [input('A')]))).toBe(false);
  });
  test('still rejects excessive OP_RETURN data or output counts in self-transfers', () => {
    expect(isSpam(tx([output('A'), opReturn(push(81))], [input('A')]))).toBe(true);
    expect(isSpam(tx([output('A'), opReturn(), opReturn()], [input('A')]))).toBe(true);
  });
  test('clears cached spam flags previously assigned to self-transfers', () => {
    const transaction = tx([output('A'), opReturn(push(80))], [input('A')]);
    transaction.flags = Number(TransactionFlags.op_return | TransactionFlags.op_return_spam);
    transaction.spam = true;
    expect(isSpam(transaction)).toBe(false);
    expect(BigInt(transaction.flags!) & TransactionFlags.op_return_spam).toBe(0n);
  });
  test('does not equate empty or incomplete address sets', () => {
    expect(isSpam(tx([opReturn()]))).toBe(false);
    expect(isSpam(tx([output('A'), opReturn()], [input('A'), { ...input(), prevout: undefined }]))).toBe(false);
    expect(isSpam(tx([output('A'), { ...output(), scriptpubkey_address: undefined }, opReturn()]))).toBe(false);
  });
  test('refreshes cached flags and stale spam booleans', () => {
    const transaction = tx([output(), opReturn(push(80))]);
    transaction.flags = Number(TransactionFlags.op_return | TransactionFlags.v2);
    transaction.spam = true;
    expect(isSpam(transaction)).toBe(false);
    transaction.vout[1].scriptpubkey = '6a' + push(81);
    expect(isSpam(transaction)).toBe(true);
  });
});

describe('OP_DROP data policy', () => {
  test.each([80, 81])('checks the %i-byte boundary', length => {
    expect(isSpam(tx([output('', push(length) + '7551', 'unknown')]))).toBe(length > 80);
  });
  test('sums immediate drops across scripts and inputs', () => {
    expect(isSpam(tx([output()], [taproot(push(40) + '75' + push(41) + '7551')]))).toBe(true);
    expect(isSpam(tx([output()], [taproot(push(40) + '7551'), taproot(push(41) + '7551')]))).toBe(true);
  });
  test('counts two immediate pushes consumed by OP_2DROP', () => {
    expect(isSpam(tx([output()], [taproot(push(40) + push(40) + '6d51')]))).toBe(false);
    expect(isSpam(tx([output()], [taproot(push(40) + push(41) + '6d51')]))).toBe(true);
  });
  test('does not double count a push or treat payload bytes as opcodes', () => {
    expect(isSpam(tx([output()], [taproot(push(40) + push(40) + '756d51')]))).toBe(false);
    expect(isSpam(tx([output()], [taproot(push(100, '75') + 'ac')]))).toBe(false);
  });
  test.each(['b1', 'b2'])('excludes normal timelock cleanup after opcode %s', opcode => {
    expect(isSpam(tx([output()], [taproot(('03010203' + opcode + '75').repeat(30) + '51')]))).toBe(false);
  });
  test.each(['p2', 'p4'])('supports %s data pushes', encoding => {
    expect(isSpam(tx([output()], [taproot(push(81, 'ab', encoding) + '7551')]))).toBe(true);
  });
  test('recognizes revealed P2WSH and P2SH scripts', () => {
    const script = push(81) + '7551';
    expect(isSpam(tx([output()], [{ ...input(), prevout: output('A', '0020' + '11'.repeat(32), 'v0_p2wsh'), witness: [script] }]))).toBe(true);
    expect(isSpam(tx([output()], [{ ...input(), prevout: output('A', 'a914' + '11'.repeat(20) + '87', 'p2sh'), scriptsig: push(script.length / 2, '00').slice(0, 4) + script }]))).toBe(true);
    const redeem = '0020' + '11'.repeat(32);
    expect(isSpam(tx([output()], [{ ...input(), prevout: output('A', 'a914' + '11'.repeat(20) + '87', 'p2sh'), scriptsig: '22' + redeem, witness: [script] }]))).toBe(true);
  });
  test('recognizes direct scriptSig opcodes', () => {
    expect(isSpam(tx([output()], [{ ...input(), scriptsig: push(81) + '75' }]))).toBe(true);
  });
  test('does not scan arbitrary witness arguments, signatures or hidden scripts', () => {
    const data = push(81) + '75';
    expect(isSpam(tx([output()], [{ ...input(), witness: [data, '02' + '11'.repeat(32)] }]))).toBe(false);
    expect(isSpam(tx([output()], [{ ...taproot('51'), witness: [data, '51', control] }]))).toBe(false);
    expect(isSpam(tx([output('B', '0020' + '11'.repeat(32), 'v0_p2wsh')]))).toBe(false);
  });
  test('extracts a tapscript with annex and without prevout metadata', () => {
    const script = push(81) + '7551';
    const withAnnex = tx([output()], [taproot(script, '50abcd')]);
    expect(BigInt(Common.getTransactionFlags(withAnnex)) & TransactionFlags.op_drop).not.toBe(0n);
    const withoutPrevout = tx([output()], [{ ...taproot(script), prevout: undefined }]);
    expect(BigInt(Common.getTransactionFlags(withoutPrevout)) & TransactionFlags.op_drop).not.toBe(0n);
  });
  test('does not scan code after OP_RETURN as executed drops', () => {
    expect(isSpam(tx([output('', '6a' + push(81) + '75', 'unknown')]))).toBe(false);
  });
});

describe('Health parity', () => {
  test('full transactions and summaries agree, including repeated classification', () => {
    const coinbase = tx([opReturn(push(100))], [{ is_coinbase: true, scriptsig: '0101', sequence: 0xffffffff }]);
    coinbase.weight = 400;
    const ordinary = tx([output(), opReturn(push(80))]);
    const spam = tx([output()], [taproot(push(81) + '7551')]);
    const transactions = [coinbase, ordinary, spam];
    expect(Audit.computeSpamHealth(transactions)).toBe(60);
    expect(Audit.computeSpamHealth(transactions)).toBe(60);
    expect(Audit.computeSpamHealthFromClassified(Common.classifyTransactions(transactions))).toBe(60);
  });
  test('ordinary OP_RETURN flags alone do not reduce summary Health', () => {
    expect(Audit.computeSpamHealthFromClassified([
      { txid: 'coinbase', vsize: 100, flags: 0 },
      { txid: 'normal', vsize: 200, flags: Number(TransactionFlags.op_return) },
    ] as any)).toBe(100);
  });
  test.each([
    TransactionFlags.fake_pubkey, TransactionFlags.inscription, TransactionFlags.fake_scripthash,
    TransactionFlags.annex, TransactionFlags.opnet, TransactionFlags.op_return_spam, TransactionFlags.op_drop,
  ])('preserves spam flag %s through full and summary calculations', flag => {
    const coinbase = tx();
    const transaction = tx();
    if (flag === TransactionFlags.op_return_spam) transaction.vout.push(opReturn(push(81)) as any);
    else if (flag === TransactionFlags.op_drop) transaction.vout.push(output('', push(81) + '7551', 'unknown') as any);
    else transaction.flags = Number(flag);
    expect(Audit.computeSpamHealth([coinbase, transaction])).toBe(50);
    expect(Audit.computeSpamHealthFromClassified(Common.classifyTransactions([coinbase, transaction]))).toBe(50);
  });
});
