import config from '../config';
import { IDifficultyAdjustment } from '../mempool.interfaces';
import {
  ASERT_HALF_LIFE,
  DEFAULT_PURITY_ACTIVATION_HEIGHT,
  MAINNET_ASERT_ANCHOR_HEIGHT,
  POW_TARGET_SPACING,
  difficultyChangeFromTarget,
  getNextAsertTarget,
} from './asert';
import logger from '../logger';

export interface DifficultyAdjustment {
  progressPercent: number;       // Percent: 0 to 100
  difficultyChange: number;      // Percent (ASERT: uncapped; legacy: -75 to 300)
  estimatedRetargetDate: number; // Unix time in ms
  remainingBlocks: number;       // Block count
  remainingTime: number;         // Duration of time in ms
  previousRetarget: number;      // Percent
  previousTime: number;          // Unix time in ms
  nextRetargetHeight: number;    // Block Height
  timeAvg: number;               // Duration of time in ms
  adjustedTimeAvg;               // Expected block interval with hashrate implied over last 504 blocks
  timeOffset: number;            // (Testnet) Time since last block (cap @ 20min) in ms
  expectedBlocks: number;         // Block count
  algorithm?: 'legacy' | 'asert';
}

/** Half-life window in blocks (24h / 10min) used for ASERT UI progress. */
export const ASERT_EPOCH_BLOCKS = ASERT_HALF_LIFE / POW_TARGET_SPACING; // 144

/**
 * Calculate the difficulty increase/decrease by using the `bits` integer contained in two
 * block headers.
 *
 * Warning: Only compare `bits` from blocks in two adjacent difficulty periods. This code
 * assumes the maximum difference is x4 or /4 (as per the protocol) and will throw an
 * error if an exponent difference of 2 or more is seen.
 *
 * @param {number} oldBits The 32 bit `bits` integer from a block header.
 * @param {number} newBits The 32 bit `bits` integer from a block header in the next difficulty period.
 * @returns {number} A floating point decimal of the difficulty change from old to new.
 *          (ie. 21.3 means 21.3% increase in difficulty, -21.3 is a 21.3% decrease in difficulty)
 */
export function calcBitsDifference(oldBits: number, newBits: number): number {
  // Must be
  // - integer
  // - highest exponent is 0x20, so max value (as integer) is 0x207fffff
  // - min value is 1 (exponent = 0)
  // - highest bit of the number-part is +- sign, it must not be 1
  const verifyBits = (bits: number): void => {
    if (
      Math.floor(bits) !== bits ||
      bits > 0x207fffff ||
      bits < 1 ||
      (bits & 0x00800000) !== 0 ||
      (bits & 0x007fffff) === 0
    ) {
      throw new Error('Invalid bits');
    }
  };
  verifyBits(oldBits);
  verifyBits(newBits);

  // No need to mask exponents because we checked the bounds above
  const oldExp = oldBits >> 24;
  const newExp = newBits >> 24;
  const oldNum = oldBits & 0x007fffff;
  const newNum = newBits & 0x007fffff;
  // The diff can only possibly be 1, 0, -1
  // (because maximum difficulty change is x4 or /4 (2 bits up or down))
  let result: number;
  switch (newExp - oldExp) {
    // New less than old, target lowered, difficulty increased
    case -1:
      result = ((oldNum << 8) * 100) / newNum - 100;
      break;
    // Same exponent, compare numbers as is.
    case 0:
      result = (oldNum * 100) / newNum - 100;
      break;
    // Old less than new, target raised, difficulty decreased
    case 1:
      result = (oldNum * 100) / (newNum << 8) - 100;
      break;
    default:
      throw new Error('Impossible exponent difference');
  }

  // Min/Max values
  return result > 300 ? 300 : result < -75 ? -75 : result;
}

export function calcDifficultyAdjustment(
  DATime: number,
  quarterEpochTime: number | null,
  nowSeconds: number,
  blockHeight: number,
  previousRetarget: number,
  network: string,
  latestBlockTimestamp: number,
): DifficultyAdjustment {
  const EPOCH_BLOCK_LENGTH = 2016; // Bitcoin mainnet
  const BLOCK_SECONDS_TARGET = 600; // Bitcoin mainnet
  const TESTNET_MAX_BLOCK_SECONDS = 1200; // Bitcoin testnet

  const diffSeconds = Math.max(0, nowSeconds - DATime);
  const blocksInEpoch = (blockHeight >= 0) ? blockHeight % EPOCH_BLOCK_LENGTH : 0;
  const progressPercent = (blockHeight >= 0) ? blocksInEpoch / EPOCH_BLOCK_LENGTH * 100 : 100;
  const remainingBlocks = EPOCH_BLOCK_LENGTH - blocksInEpoch;
  const nextRetargetHeight = (blockHeight >= 0) ? blockHeight + remainingBlocks : 0;
  const expectedBlocks = diffSeconds / BLOCK_SECONDS_TARGET;
  const actualTimespan = (blocksInEpoch === 2015 ? latestBlockTimestamp : nowSeconds) - DATime;

  let difficultyChange = 0;
  let timeAvgSecs = blocksInEpoch ? diffSeconds / blocksInEpoch : BLOCK_SECONDS_TARGET;
  let adjustedTimeAvgSecs = timeAvgSecs;

  // for the first 504 blocks of the epoch, calculate the expected avg block interval
  // from a sliding window over the last 504 blocks
  if (quarterEpochTime && blocksInEpoch < 503) {
    const timeLastEpoch = DATime - quarterEpochTime;
    const adjustedTimeLastEpoch = timeLastEpoch * (1 + (previousRetarget / 100));
    const adjustedTimeSpan = diffSeconds + adjustedTimeLastEpoch;
    adjustedTimeAvgSecs = adjustedTimeSpan / 503;
    difficultyChange = (BLOCK_SECONDS_TARGET / (adjustedTimeSpan / 504) - 1) * 100;
  } else {
    difficultyChange = (BLOCK_SECONDS_TARGET / (actualTimespan / (blocksInEpoch + 1)) - 1) * 100;
  }

  // Max increase is x4 (+300%)
  if (difficultyChange > 300) {
    difficultyChange = 300;
  }
  // Max decrease is /4 (-75%)
  if (difficultyChange < -75) {
    difficultyChange = -75;
  }

  // Testnet difficulty is set to 1 after 20 minutes of no blocks,
  // therefore the time between blocks will always be below 20 minutes (1200s).
  let timeOffset = 0;
  if (network === 'testnet') {
    if (timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeAvgSecs = TESTNET_MAX_BLOCK_SECONDS;
    }

    const secondsSinceLastBlock = nowSeconds - latestBlockTimestamp;
    if (secondsSinceLastBlock + timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeOffset = -Math.min(secondsSinceLastBlock, TESTNET_MAX_BLOCK_SECONDS) * 1000;
    }
  }

  const timeAvg = Math.floor(timeAvgSecs * 1000);
  const adjustedTimeAvg = Math.floor(adjustedTimeAvgSecs * 1000);
  const remainingTime = remainingBlocks * adjustedTimeAvg;
  const estimatedRetargetDate = remainingTime + nowSeconds * 1000;

  return {
    progressPercent,
    difficultyChange,
    estimatedRetargetDate,
    remainingBlocks,
    remainingTime,
    previousRetarget,
    previousTime: DATime,
    nextRetargetHeight,
    timeAvg,
    adjustedTimeAvg,
    timeOffset,
    expectedBlocks,
    algorithm: 'legacy',
  };
}

/**
 * Purity aserti3-1d difficulty stats for the dashboard / API.
 * Next block always retargets; difficultyChange is the exact next-block ASERT delta vs tip.
 */
export function calcAsertDifficultyAdjustment(
  nowSeconds: number,
  tipHeight: number,
  tipTimestamp: number,
  tipBits: number,
  previousRetarget: number,
  previousAdjustmentTime: number,
  halfLifeWindowTime: number | null,
  nextTarget: bigint,
  network: string,
): DifficultyAdjustment {
  const BLOCK_SECONDS_TARGET = POW_TARGET_SPACING;
  const TESTNET_MAX_BLOCK_SECONDS = 1200;

  const blocksInEpoch = tipHeight >= 0 ? tipHeight % ASERT_EPOCH_BLOCKS : 0;
  const progressPercent = tipHeight >= 0 ? (blocksInEpoch / ASERT_EPOCH_BLOCKS) * 100 : 100;
  const remainingBlocks = 1;
  const nextRetargetHeight = tipHeight >= 0 ? tipHeight + 1 : 0;

  const windowStart = halfLifeWindowTime ?? previousAdjustmentTime;
  const windowBlocks = halfLifeWindowTime != null
    ? (ASERT_EPOCH_BLOCKS - 1)
    : Math.max(1, tipHeight > 0 ? tipHeight : 1);
  const windowSeconds = Math.max(0, tipTimestamp - windowStart);
  let timeAvgSecs = windowSeconds > 0 ? windowSeconds / windowBlocks : BLOCK_SECONDS_TARGET;
  // Fall back toward ideal spacing if the window is degenerate
  if (!Number.isFinite(timeAvgSecs) || timeAvgSecs <= 0) {
    timeAvgSecs = BLOCK_SECONDS_TARGET;
  }

  const difficultyChange = difficultyChangeFromTarget(tipBits, nextTarget);
  // Under ASERT the equilibrium block interval is the ideal spacing once difficulty settles
  const adjustedTimeAvgSecs = BLOCK_SECONDS_TARGET;

  let timeOffset = 0;
  if (network === 'testnet') {
    if (timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeAvgSecs = TESTNET_MAX_BLOCK_SECONDS;
    }
    const secondsSinceLastBlock = nowSeconds - tipTimestamp;
    if (secondsSinceLastBlock + timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeOffset = -Math.min(secondsSinceLastBlock, TESTNET_MAX_BLOCK_SECONDS) * 1000;
    }
  }

  const timeAvg = Math.floor(timeAvgSecs * 1000);
  const adjustedTimeAvg = Math.floor(adjustedTimeAvgSecs * 1000);
  const remainingTime = remainingBlocks * adjustedTimeAvg;
  const estimatedRetargetDate = remainingTime + nowSeconds * 1000;
  const expectedBlocks = Math.max(0, nowSeconds - windowStart) / BLOCK_SECONDS_TARGET;

  return {
    progressPercent,
    difficultyChange,
    estimatedRetargetDate,
    remainingBlocks,
    remainingTime,
    previousRetarget,
    previousTime: previousAdjustmentTime,
    nextRetargetHeight,
    timeAvg,
    adjustedTimeAvg,
    timeOffset,
    expectedBlocks,
    algorithm: 'asert',
  };
}

export function getPurityActivationHeight(): number {
  return config.PURITY?.ACTIVATION_HEIGHT ?? DEFAULT_PURITY_ACTIVATION_HEIGHT;
}

export function getAsertAnchorHeight(): number {
  return config.PURITY?.ASERT_ANCHOR_HEIGHT ?? MAINNET_ASERT_ANCHOR_HEIGHT;
}

export function isAsertActive(nextBlockHeight: number): boolean {
  if (['liquid', 'liquidtestnet'].includes(config.MEMPOOL.NETWORK)) {
    return false;
  }
  return nextBlockHeight >= getPurityActivationHeight();
}

class DifficultyAdjustmentApi {
  public getDifficultyAdjustment(): IDifficultyAdjustment | null {
    // Lazy import avoids pulling the full blocks graph into pure unit tests
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const blocks = require('./blocks').default as typeof import('./blocks').default;
    const previousRetarget = blocks.getPreviousDifficultyRetarget();
    const blocksCache = blocks.getBlocks();
    const latestBlock = blocksCache[blocksCache.length - 1];
    if (!latestBlock) {
      return null;
    }
    // Prefer the tip height from the block cache (matches what the UI shows)
    const tipHeight = Math.max(blocks.getCurrentBlockHeight(), latestBlock.height);
    const nowSeconds = Math.floor(new Date().getTime() / 1000);

    // ASERT applies when computing work for the *next* block (tip.height + 1 >= activation).
    // At tip === activation (e.g. 961636), the tip itself is already an ASERT block.
    if (isAsertActive(tipHeight + 1)) {
      const anchor = blocks.getAsertAnchor();
      if (!anchor) {
        // Do NOT fall back to the 2016-block DAA — that produces multi-week ETAs.
        logger.debug('ASERT active but anchor not loaded yet; skipping difficulty-adjustment payload');
        return null;
      }
      const tipBits = latestBlock.bits ?? blocks.getCurrentBits();
      if (!tipBits) {
        return null;
      }
      const nextTarget = getNextAsertTarget(anchor, tipHeight, latestBlock.timestamp);
      return calcAsertDifficultyAdjustment(
        nowSeconds,
        tipHeight,
        latestBlock.timestamp,
        tipBits,
        previousRetarget,
        blocks.getLastDifficultyAdjustmentTime() || latestBlock.timestamp,
        blocks.getAsertWindowBlockTime(),
        nextTarget,
        config.MEMPOOL.NETWORK,
      );
    }

    const DATime = blocks.getLastDifficultyAdjustmentTime();
    const quarterEpochBlockTime = blocks.getQuarterEpochBlockTime();
    return calcDifficultyAdjustment(
      DATime, quarterEpochBlockTime, nowSeconds, tipHeight, previousRetarget,
      config.MEMPOOL.NETWORK, latestBlock.timestamp
    );
  }
}

export default new DifficultyAdjustmentApi();
