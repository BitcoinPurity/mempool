import { Application, Request, Response } from 'express';
import config from '../../config';
import logger from '../../logger';
import supplyRepository, { BalanceRecord, SupplyDistributionRepository, SupplyState } from '../../repositories/SupplyDistributionRepository';
import { MAX_SUPPLY_SATS, issuedSupplyAt } from './supply-model';
import { addressToScript, describeScript, scriptHash, supplyNetwork } from './supply-script';

const MAX_PAGE_SIZE = 100;
const SCRIPT_PREVIEW_BYTES = 64;

function compareRank(a: BalanceRecord, b: BalanceRecord): number {
  // Ordering of the list: balance DESC, script_hash DESC. Negative means `a` ranks higher.
  if (a.balance !== b.balance) {
    return b.balance - a.balance;
  }
  return Buffer.compare(b.scriptHash, a.scriptHash);
}

export class SupplyDistributionRoutes {
  private threshold: { height: number, hash: string, row: BalanceRecord | null } | null = null;

  constructor(private repository: SupplyDistributionRepository = supplyRepository,
    private topN = config.SUPPLY_DISTRIBUTION.TOP_N,
    private network = supplyNetwork(config.MEMPOOL.NETWORK),
    private confirmations = config.SUPPLY_DISTRIBUTION.CONFIRMATIONS) { }

  initRoutes(app: Application): void {
    app.get(config.MEMPOOL.API_URL_PREFIX + 'supply/distribution', this.getDistribution.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'supply/top-addresses', this.getTopAddresses.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'supply/address/:address', this.getAddress.bind(this));
  }

  private stateFields(state: SupplyState): Record<string, unknown> {
    return { status: state.status, height: state.height, hash: state.hash, updatedAt: state.updatedAt, confirmations: this.confirmations };
  }

  /** @asyncUnsafe */
  private async $loadState(res: Response): Promise<SupplyState | null> {
    res.setHeader('Cache-Control', 'public, max-age=10');
    const state = await this.repository.$getState();
    if (!state) {
      res.status(404).json({ error: 'no_data' });
      return null;
    }
    return state;
  }

  /** Lowest-ranked row still inside the top N, cached per data height. */
  /** @asyncUnsafe */
  private async $getThreshold(state: SupplyState): Promise<BalanceRecord | null> {
    if (!this.threshold || this.threshold.height !== state.height || this.threshold.hash !== state.hash) {
      this.threshold = { height: state.height, hash: state.hash, row: await this.repository.$getRankedRow(this.topN) };
    }
    return this.threshold.row;
  }

  private async getDistribution(_req: Request, res: Response): Promise<void> {
    try {
      const state = await this.$loadState(res);
      if (!state) {
        return;
      }
      const buckets = await this.repository.$getBuckets();
      res.json({
        ...this.stateFields(state),
        totalAmount: state.totalAmount,
        issuedAmount: issuedSupplyAt(state.height),
        maxSupply: MAX_SUPPLY_SATS,
        utxoCount: state.utxoCount,
        scriptCount: state.scriptCount,
        nonZeroScriptCount: state.scriptCount - state.zeroBalanceScripts,
        zeroBalanceScripts: state.zeroBalanceScripts,
        buckets,
      });
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private async getTopAddresses(req: Request, res: Response): Promise<void> {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? MAX_PAGE_SIZE : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      res.status(400).json({ error: 'invalid_limit' });
      return;
    }
    if (!Number.isInteger(page) || page < 1 || (page - 1) * limit >= this.topN) {
      res.status(400).json({ error: 'invalid_page' });
      return;
    }
    try {
      const state = await this.$loadState(res);
      if (!state) {
        return;
      }
      const offset = (page - 1) * limit;
      const rows = await this.repository.$getTopBalances(offset, Math.min(limit, this.topN - offset));
      res.json({
        ...this.stateFields(state),
        totalAmount: state.totalAmount,
        total: Math.min(this.topN, state.scriptCount),
        page,
        limit,
        rows: rows.map((row, i) => {
          const description = describeScript(row.script, this.network);
          return {
            rank: offset + i + 1,
            address: description.address,
            type: description.type,
            script: description.address ? undefined : row.script.subarray(0, SCRIPT_PREVIEW_BYTES).toString('hex'),
            scriptTruncated: description.address ? undefined : row.script.length > SCRIPT_PREVIEW_BYTES,
            balance: row.balance,
            utxoCount: row.utxoCount,
          };
        }),
      });
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private async getAddress(req: Request, res: Response): Promise<void> {
    const raw = String(req.params.address || '');
    const address = /^(bc1|tb1|bcrt1)/i.test(raw) ? raw.toLowerCase() : raw;
    const script = addressToScript(address, this.network);
    if (!script) {
      res.status(400).json({ error: 'invalid_address' });
      return;
    }
    try {
      const state = await this.$loadState(res);
      if (!state) {
        return;
      }
      const record = await this.repository.$getBalance(scriptHash(script));
      const threshold = record ? await this.$getThreshold(state) : null;
      if (!record || (threshold && compareRank(record, threshold) > 0)) {
        res.status(404).json({ error: 'not_ranked', ...this.stateFields(state), topN: this.topN });
        return;
      }
      res.json({
        ...this.stateFields(state),
        rank: await this.repository.$getRank(record),
        topN: this.topN,
        balance: record.balance,
        utxoCount: record.utxoCount,
        share: state.totalAmount > 0 ? record.balance / state.totalAmount : 0,
      });
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private sendError(res: Response, error: unknown): void {
    logger.err(`Supply distribution API error: ${error instanceof Error ? error.message : error}`);
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(500).json({ error: 'internal_error' });
    }
  }
}

export default new SupplyDistributionRoutes();
