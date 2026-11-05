import config from '../../config';
import logger from '../../logger';
import blocks from '../blocks';
import bitcoinClient from '../bitcoin/bitcoin-client';
import { bitcoinCoreApi } from '../bitcoin/bitcoin-api-factory';
import { IEsploraApi } from '../bitcoin/esplora-api.interface';
import supplyRepository, { BlockRef, SupplyDistributionRepository, SupplyInconsistencyError, SupplyState,
  SupplyStateConflictError } from '../../repositories/SupplyDistributionRepository';
import { SupplyBootstrap } from './supply-bootstrap';
import { buildBlockDelta } from './supply-delta';

const TICK_INTERVAL_MS = 10_000;
const BOOTSTRAP_RETRY_MS = 6 * 3600_000;
/** Float BTC amounts from RPC can be off by a fraction of a satoshi after conversion. */
const COINSTATS_TOLERANCE_SATS = 1;

export interface SupplyFollowerDeps {
  repository: SupplyDistributionRepository;
  coreApi: {
    $getBlockHash(height: number): Promise<string>;
    $getTxsForBlock(hash: string): Promise<IEsploraApi.Transaction[]>;
  };
  rpc: {
    getBlockHeader(hash: string): Promise<{ previousblockhash?: string }>;
    getIndexInfo(name: string): Promise<any>;
    getTxoutSetinfo(hashType: string, height: number): Promise<{ txouts: number, total_amount: number }>;
  };
  bootstrap: { $run(): Promise<SupplyState> };
  tipHeight: () => number;
  confirmations: number;
  now: () => number;
}

function isHeightOutOfRange(error: unknown): boolean {
  return (error as { code?: number })?.code === -8;
}

/**
 * Keeps per-script balances at `tip - CONFIRMATIONS`, one block at a time. Blocks that left the main
 * chain are undone with their own prevouts (getblock verbosity 3 works for stale blocks the node
 * connected before). Any inconsistency marks the state stale and stops updates until an operator
 * clears the state, which triggers a new bootstrap.
 */
export class SupplyFollower {
  private deps: SupplyFollowerDeps;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private nextBootstrapAt = 0;

  constructor(deps: Partial<SupplyFollowerDeps> = {}) {
    this.deps = {
      repository: supplyRepository,
      coreApi: bitcoinCoreApi,
      rpc: bitcoinClient,
      bootstrap: new SupplyBootstrap(),
      tipHeight: (): number => blocks.getCurrentBlockHeight(),
      confirmations: config.SUPPLY_DISTRIBUTION.CONFIRMATIONS,
      now: (): number => Date.now(),
      ...deps,
    };
  }

  start(): void {
    this.stopped = false;
    /** @asyncSafe */
    const loop = async (): Promise<void> => {
      await this.$tick();
      if (!this.stopped) {
        this.timer = setTimeout(() => { void loop(); }, TICK_INTERVAL_MS);
      }
    };
    this.timer = setTimeout(() => { void loop(); }, TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  /** One follower pass; never throws. */
  /** @asyncSafe */
  async $tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const state = await this.deps.repository.$getState();
      if (!state) {
        await this.$maybeBootstrap();
        return;
      }
      if (state.status === 'stale') {
        return;
      }
      const tip = this.deps.tipHeight();
      if (tip < 0) {
        return;
      }
      let current: SupplyState | null = await this.$rewindToMainChain(state);
      const target = tip - this.deps.confirmations;
      while (current && current.height < target && !this.stopped) {
        current = await this.$connectNext(current);
      }
      if (current && current.status === 'bootstrapping' && current.height <= target) {
        await this.deps.repository.$setStatus('ready');
        logger.notice(`Supply distribution ready at block ${current.height}`);
      }
    } catch (e) {
      if (e instanceof SupplyInconsistencyError) {
        await this.$markStale(e.message);
      } else if (e instanceof SupplyStateConflictError) {
        logger.warn(`Supply follower: ${e.message}; retrying`);
      } else {
        logger.err(`Supply follower error: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      this.running = false;
    }
  }

  /** @asyncSafe */
  private async $maybeBootstrap(): Promise<void> {
    if (this.deps.now() < this.nextBootstrapAt) {
      return;
    }
    this.nextBootstrapAt = this.deps.now() + BOOTSTRAP_RETRY_MS;
    try {
      await this.deps.bootstrap.$run();
    } catch (e) {
      logger.err(`Supply bootstrap failed, retrying in ${BOOTSTRAP_RETRY_MS / 3600_000}h: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** @asyncSafe */
  private async $markStale(reason: string): Promise<void> {
    logger.err(`Supply distribution marked stale and paused: ${reason}. Clear supply_state to bootstrap again.`);
    try {
      await this.deps.repository.$setStatus('stale');
    } catch (e) {
      logger.err(`Could not mark supply state stale: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** @asyncUnsafe */
  private async $mainChainHash(height: number): Promise<string | null> {
    try {
      return await this.deps.coreApi.$getBlockHash(height);
    } catch (e) {
      if (isHeightOutOfRange(e)) {
        return null;
      }
      throw e;
    }
  }

  /** Undo stored blocks until the stored tip is on the node's active chain. */
  /** @asyncUnsafe */
  private async $rewindToMainChain(state: SupplyState): Promise<SupplyState | null> {
    let current = state;
    while ((await this.$mainChainHash(current.height)) !== current.hash) {
      logger.warn(`Supply follower: block ${current.height} ${current.hash} left the main chain, undoing it`);
      const header = await this.deps.rpc.getBlockHeader(current.hash);
      if (!header.previousblockhash) {
        throw new SupplyInconsistencyError(`Cannot undo block ${current.hash}: no parent`);
      }
      let transactions: IEsploraApi.Transaction[];
      try {
        transactions = await this.deps.coreApi.$getTxsForBlock(current.hash);
      } catch (e) {
        throw new SupplyInconsistencyError(`Cannot read stale block ${current.hash} to undo it: ${e instanceof Error ? e.message : e}`);
      }
      let deltas;
      try {
        deltas = buildBlockDelta(transactions, -1);
      } catch (e) {
        throw new SupplyInconsistencyError(`Cannot undo block ${current.hash}: ${e instanceof Error ? e.message : e}`);
      }
      const parent: BlockRef = { height: current.height - 1, hash: header.previousblockhash };
      current = await this.deps.repository.$applyDelta(current, parent, deltas);
      if (!(await this.$verify(current))) {
        return null;
      }
    }
    return current;
  }

  /** @asyncUnsafe */
  private async $connectNext(state: SupplyState): Promise<SupplyState | null> {
    const height = state.height + 1;
    const started = this.deps.now();
    const hash = await this.deps.coreApi.$getBlockHash(height);
    const header = await this.deps.rpc.getBlockHeader(hash);
    if (header.previousblockhash !== state.hash) {
      // The chain moved under us; the next pass rewinds first.
      return null;
    }
    const deltas = buildBlockDelta(await this.deps.coreApi.$getTxsForBlock(hash), 1);
    const next = await this.deps.repository.$applyDelta(state, { height, hash }, deltas);
    logger.debug(`Supply follower: applied block ${height} (${deltas.length} scripts changed) in ${this.deps.now() - started}ms`);
    return (await this.$verify(next)) ? next : null;
  }

  /** Compare totals with coinstatsindex when it covers the height; mark stale on mismatch. */
  /** @asyncUnsafe */
  private async $verify(state: SupplyState): Promise<boolean> {
    let index;
    try {
      index = (await this.deps.rpc.getIndexInfo('coinstatsindex'))?.coinstatsindex;
    } catch (e) {
      return true;
    }
    if (!index || index.best_block_height < state.height) {
      return true;
    }
    const info = await this.deps.rpc.getTxoutSetinfo('none', state.height);
    const total = Math.round(info.total_amount * 100_000_000);
    if (info.txouts !== state.utxoCount || Math.abs(total - state.totalAmount) > COINSTATS_TOLERANCE_SATS) {
      await this.$markStale(`coinstatsindex mismatch at ${state.height}: node ${info.txouts} UTXOs / ${total} sats, ` +
        `supply ${state.utxoCount} UTXOs / ${state.totalAmount} sats`);
      return false;
    }
    return true;
  }
}

export default new SupplyFollower();
