import { IEsploraApi } from '../bitcoin/esplora-api.interface';
import { isUnspendable, scriptHash } from './supply-script';

export interface ScriptDelta {
  scriptHash: Buffer;
  script: Buffer;
  amount: number;
  utxos: number;
}

export class MissingPrevoutError extends Error {
  constructor(txid: string, index: number) {
    super(`Missing prevout for input ${index} of ${txid}`);
    this.name = 'MissingPrevoutError';
  }
}

/**
 * Net per-script change of the UTXO set caused by one block. Outputs add, spent prevouts subtract;
 * unspendable outputs never enter the UTXO set. `direction` -1 produces the delta that undoes the block.
 */
export function buildBlockDelta(transactions: IEsploraApi.Transaction[], direction: 1 | -1 = 1): ScriptDelta[] {
  const deltas = new Map<string, ScriptDelta>();
  const add = (scriptHex: string, amount: number, utxos: number): void => {
    const script = Buffer.from(scriptHex, 'hex');
    if (isUnspendable(script)) {
      return;
    }
    const hash = scriptHash(script);
    const id = hash.toString('hex');
    const delta = deltas.get(id);
    if (delta) {
      delta.amount += amount;
      delta.utxos += utxos;
    } else {
      deltas.set(id, { scriptHash: hash, script, amount, utxos });
    }
  };
  for (const tx of transactions) {
    for (const output of tx.vout) {
      add(output.scriptpubkey, output.value * direction, direction);
    }
    tx.vin.forEach((input, index) => {
      if (input.is_coinbase) {
        return;
      }
      if (!input.prevout) {
        throw new MissingPrevoutError(tx.txid, index);
      }
      add(input.prevout.scriptpubkey, -input.prevout.value * direction, -direction);
    });
  }
  return [...deltas.values()].filter((delta) => delta.amount !== 0 || delta.utxos !== 0);
}
