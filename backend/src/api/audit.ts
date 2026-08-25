import config from '../config';
import logger from '../logger';
import { MempoolTransactionExtended, MempoolBlockWithTransactions, TransactionExtended, TransactionClassified, TransactionFlags } from '../mempool.interfaces';
import { Common } from './common';
import rbfCache from './rbf-cache';
import transactionUtils from './transaction-utils';

const PROPAGATION_MARGIN = 180; // in seconds, time since a transaction is first seen after which it is assumed to have propagated to all miners

// Flags that map to tx.spam during classification (used for summary-based health)
const SPAM_FLAGS = Number(
  TransactionFlags.op_return |
  TransactionFlags.fake_pubkey |
  TransactionFlags.inscription |
  TransactionFlags.fake_scripthash |
  TransactionFlags.annex |
  TransactionFlags.opnet
);

export interface AuditResult {
  unseen: string[];
  censored: string[];
  added: string[];
  prioritized: string[];
  fresh: string[];
  sigop: string[];
  fullrbf: string[];
  accelerated: string[];
  matchRate: number;
  similarity: number;
}

class Audit {
  /**
   * Block health score based on non-spam transaction weight share.
   * Does not require mempool sync or a projected block template.
   */
  public computeSpamHealth(transactions: TransactionExtended[], height?: number): number {
    if (!transactions?.length) {
      return 100;
    }

    Common.classifyTransactions(transactions, height);

    let spamWeight = 0;
    let blkWeight = 0;
    for (const tx of transactions) {
      blkWeight += tx.weight || 0;
    }
    for (let i = 1; i < transactions.length; i++) {
      if (transactions[i].spam) {
        spamWeight += transactions[i].weight || 0;
      }
    }

    if (!blkWeight) {
      return 100;
    }

    const score = 1 - (spamWeight / blkWeight);
    return Math.round(score * 100 * 100) / 100;
  }

  /**
   * Same health score from already-classified stripped txs (block summaries).
   * Useful for backfilling matchRate on cached tip blocks without re-fetching full txs.
   */
  public computeSpamHealthFromClassified(transactions: TransactionClassified[]): number {
    if (!transactions?.length) {
      return 100;
    }

    let spamWeight = 0;
    let blkWeight = 0;
    for (let i = 0; i < transactions.length; i++) {
      const weight = (transactions[i].vsize || 0) * 4;
      blkWeight += weight;
      if (i > 0 && ((transactions[i].flags || 0) & SPAM_FLAGS) !== 0) {
        spamWeight += weight;
      }
    }

    if (!blkWeight) {
      return 100;
    }

    const score = 1 - (spamWeight / blkWeight);
    return Math.round(score * 100 * 100) / 100;
  }

  auditBlock(
    height: number,
    transactions: MempoolTransactionExtended[],
    projectedBlocks: MempoolBlockWithTransactions[],
    mempool: { [txId: string]: MempoolTransactionExtended }
  ): AuditResult {
    if (!projectedBlocks?.[0]?.transactionIds || !mempool) {
      return { unseen: [], censored: [], added: [], prioritized: [], fresh: [], sigop: [], fullrbf: [], accelerated: [], matchRate: 100, similarity: 1 };
    }

    const matches: string[] = []; // present in both mined block and template
    const added: string[] = []; // present in mined block, not in template
    const unseen: string[] = []; // present in the mined block, not in our mempool
    let prioritized: string[] = []; // higher in the block than would be expected by in-band feerate alone
    let deprioritized: string[] = []; // lower in the block than would be expected by in-band feerate alone
    const fresh: string[] = []; // missing, but firstSeen or lastBoosted within PROPAGATION_MARGIN
    const rbf: string[] = []; // either missing or present, and either part of a full-rbf replacement, or a conflict with the mined block
    const accelerated: string[] = []; // prioritized by the mempool accelerator
    const isCensored = {}; // missing, without excuse
    const isDisplaced = {};
    const isAccelerated = {};
    let displacedWeight = 0;
    let matchedWeight = 0;
    let projectedWeight = 0;

    const inBlock = {};
    const inTemplate = {};

    const now = Math.round((Date.now() / 1000));
    for (const tx of transactions) {
      inBlock[tx.txid] = tx;
      if (mempool[tx.txid] && mempool[tx.txid].acceleration) {
        accelerated.push(tx.txid);
        isAccelerated[tx.txid] = true;
      }
    }
    // coinbase is always expected
    if (transactions[0]) {
      inTemplate[transactions[0].txid] = true;
    }
    // look for transactions that were expected in the template, but missing from the mined block
    for (const txid of projectedBlocks[0].transactionIds) {
      if (!inBlock[txid]) {
        // allow missing transactions which either belong to a full rbf tree, or conflict with any transaction in the mined block
        if (rbfCache.has(txid) && (rbfCache.isFullRbf(txid) || rbfCache.anyInSameTree(txid, (tx) => inBlock[tx.txid]))) {
          rbf.push(txid);
        } else if (mempool[txid]?.firstSeen != null && (now - (mempool[txid]?.firstSeen || 0)) <= PROPAGATION_MARGIN) {
          // tx is recent, may have reached the miner too late for inclusion
          fresh.push(txid);
        } else if (mempool[txid]?.lastBoosted != null && (now - (mempool[txid]?.lastBoosted || 0)) <= PROPAGATION_MARGIN) {
          // tx was recently cpfp'd, miner may not have the latest effective rate
          fresh.push(txid);
        } else if (mempool[txid].effectiveFeePerVsize >= 1) { // transactions paying < 1 sat/vbyte are never considered censored
          isCensored[txid] = true;
        }
        displacedWeight += mempool[txid]?.weight || 0;
      } else {
        matchedWeight += mempool[txid]?.weight || 0;
      }
      projectedWeight += mempool[txid]?.weight || 0;
      inTemplate[txid] = true;
    }

    if (transactions[0]) {
      displacedWeight += (4000 - transactions[0].weight);
      projectedWeight += transactions[0].weight;
      matchedWeight += transactions[0].weight;
    }


    // we can expect an honest miner to include 'displaced' transactions in place of recent arrivals and censored txs
    // these displaced transactions should occupy the first N weight units of the next projected block
    let displacedWeightRemaining = displacedWeight + 4000;
    let index = 0;
    let lastFeeRate = Infinity;
    let failures = 0;
    let blockIndex = 1;
    while (projectedBlocks[blockIndex] && failures < 500) {
      const txid = projectedBlocks[blockIndex].transactionIds[index];
      const tx = mempool[txid];
      if (tx) {
        const fits = (tx.weight - displacedWeightRemaining) < 4000;
        // 0.005 margin of error for any remaining vsize rounding issues
        const feeMatches = tx.effectiveFeePerVsize >= (lastFeeRate - 0.005);
        if (fits || feeMatches) {
          isDisplaced[txid] = true;
          if (fits) {
            // (tx.effectiveFeePerVsize * tx.vsize) / Math.ceil(tx.vsize) attempts to correct for vsize rounding in the simple non-CPFP case
            lastFeeRate = Math.min(lastFeeRate, (tx.effectiveFeePerVsize * tx.vsize) / Math.ceil(tx.vsize));
          }
          if (tx.firstSeen == null || (now - (tx?.firstSeen || 0)) > PROPAGATION_MARGIN) {
            displacedWeightRemaining -= tx.weight;
          }
          failures = 0;
        } else {
          failures++;
        }
      } else {
        logger.warn('projected transaction missing from mempool cache');
      }
      index++;
      if (index >= projectedBlocks[blockIndex].transactionIds.length) {
        index = 0;
        blockIndex++;
      }
    }

    // mark unexpected transactions in the mined block as 'added'
    let overflowWeight = 0;
    let totalWeight = 0;
    for (const tx of transactions) {
      if (inTemplate[tx.txid]) {
        matches.push(tx.txid);
      } else {
        if (rbfCache.has(tx.txid)) {
          rbf.push(tx.txid);
          if (!mempool[tx.txid] && !rbfCache.getReplacedBy(tx.txid)) {
            unseen.push(tx.txid);
          }
        } else {
          if (mempool[tx.txid]) {
            if (isDisplaced[tx.txid]) {
              added.push(tx.txid);
            }
          } else {
            unseen.push(tx.txid);
          }
        }
        overflowWeight += tx.weight;
      }
      totalWeight += tx.weight;
    }

    ({ prioritized, deprioritized } = transactionUtils.identifyPrioritizedTransactions(transactions, 'effectiveFeePerVsize'));

    // transactions missing from near the end of our template are probably not being censored
    let overflowWeightRemaining = overflowWeight - (config.MEMPOOL.BLOCK_WEIGHT_UNITS - totalWeight);
    let maxOverflowRate = 0;
    let rateThreshold = 0;
    index = projectedBlocks[0].transactionIds.length - 1;
    while (index >= 0) {
      const txid = projectedBlocks[0].transactionIds[index];
      const tx = mempool[txid];
      if (tx) {
        if (overflowWeightRemaining > 0) {
          if (isCensored[txid]) {
            delete isCensored[txid];
          }
          if (tx.effectiveFeePerVsize > maxOverflowRate) {
            maxOverflowRate = tx.effectiveFeePerVsize;
            rateThreshold = (Math.ceil(maxOverflowRate * 100) / 100) + 0.005;
          }
        } else if (tx.effectiveFeePerVsize <= rateThreshold) { // tolerance of 0.01 sat/vb + rounding
          if (isCensored[txid]) {
            delete isCensored[txid];
          }
        }
        overflowWeightRemaining -= (mempool[txid]?.weight || 0);
      } else {
        logger.warn('projected transaction missing from mempool cache');
      }
      index--;
    }

    const similarity = projectedWeight ? matchedWeight / projectedWeight : 1;
    const matchRate = this.computeSpamHealth(transactions, height);

    return {
      unseen,
      censored: Object.keys(isCensored),
      added,
      prioritized,
      fresh,
      sigop: [],
      fullrbf: rbf,
      accelerated,
      matchRate,
      similarity,
    };
  }
}

export default new Audit();