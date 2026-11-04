jest.mock('../../api/blocks', () => ({ __esModule: true, default: { getCurrentBlockHeight: () => -1 } }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ __esModule: true, default: {}, bitcoinCoreApi: {} }));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({ __esModule: true, default: {} }));

import { IEsploraApi } from '../../api/bitcoin/esplora-api.interface';
import { ScriptDelta } from '../../api/supply/supply-delta';
import { emptyBuckets, BucketTotals } from '../../api/supply/supply-model';
import { SupplyFollower } from '../../api/supply/supply-follower';
import {
  BlockRef, SupplyDistributionRepository, SupplyState, SupplyStateConflictError, SupplyStatus, planDeltaApplication,
} from '../../repositories/SupplyDistributionRepository';
import { p2pkh, testOutput, testTx } from './supply-test-utils';

const COINBASE = 5_000_000_000;

/** In-memory stand-in for the SQL repository, using the same planner. */
class MemoryRepository {
  state: SupplyState | null = null;
  buckets: BucketTotals[] = emptyBuckets();
  rows = new Map<string, { balance: number, utxoCount: number }>();
  applied: string[] = [];

  async $getState(): Promise<SupplyState | null> {
    return this.state ? { ...this.state } : null;
  }

  async $setStatus(status: SupplyStatus): Promise<void> {
    if (this.state) {
      this.state.status = status;
    }
  }

  async $applyDelta(from: BlockRef, to: BlockRef, deltas: ScriptDelta[]): Promise<SupplyState> {
    if (!this.state || this.state.height !== from.height || this.state.hash !== from.hash) {
      throw new SupplyStateConflictError('conflict');
    }
    const plan = planDeltaApplication(this.state, this.buckets, this.rows, deltas, to.height);
    for (const [hash, , balance, utxoCount] of plan.upserts) {
      this.rows.set(hash.toString('hex'), { balance, utxoCount });
    }
    for (const hash of plan.deletes) {
      this.rows.delete(hash.toString('hex'));
    }
    this.buckets = plan.buckets;
    this.state = { ...this.state, ...plan.totals, height: to.height, hash: to.hash };
    this.applied.push(`${to.height}:${to.hash}`);
    return { ...this.state };
  }
}

interface FakeBlock { hash: string, height: number, prev: string, txs: IEsploraApi.Transaction[] }

/** A chain where block h pays its coinbase to a fresh script and block h>1 spends block h-1's coinbase. */
class FakeChain {
  blocks = new Map<string, FakeBlock>();
  main: string[] = [];
  missingPrevouts = new Set<string>();

  constructor(length: number) {
    this.main = this.extend('g', 0, length);
  }

  extend(prefix: string, fromHeight: number, toHeight: number, parent = this.main[fromHeight - 1]): string[] {
    const hashes = this.main.slice(0, fromHeight);
    for (let h = fromHeight; h <= toHeight; h++) {
      const hash = `${prefix}${h}`;
      const txs = [testTx(`${hash}-cb`, ['coinbase'], [testOutput(p2pkh(h % 256), COINBASE)])];
      if (h > 0) {
        const previous = this.blocks.get(hashes[h - 1] ?? parent)!;
        const prevScript = Buffer.from(previous.txs[0].vout[0].scriptpubkey, 'hex');
        txs.push(testTx(`${hash}-spend`, [testOutput(prevScript, COINBASE)], [testOutput(p2pkh(200 + (h % 50)), COINBASE)]));
      }
      this.blocks.set(hash, { hash, height: h, prev: h === 0 ? '' : hashes[h - 1], txs });
      hashes.push(hash);
    }
    return hashes;
  }

  coreApi = {
    $getBlockHash: async (height: number): Promise<string> => {
      if (height >= this.main.length) {
        throw Object.assign(new Error('Block height out of range'), { code: -8 });
      }
      return this.main[height];
    },
    $getTxsForBlock: async (hash: string): Promise<IEsploraApi.Transaction[]> => {
      const block = this.blocks.get(hash);
      if (!block) {
        throw new Error('Block not found');
      }
      const txs = JSON.parse(JSON.stringify(block.txs));
      if (this.missingPrevouts.has(hash)) {
        txs[1].vin[0].prevout = null;
      }
      return txs;
    },
  };
}

/** Repository state equal to having bootstrapped at `height` on `chain`. */
async function bootstrapAt(chain: FakeChain, height: number): Promise<MemoryRepository> {
  const repo = new MemoryRepository();
  repo.state = {
    height: -1, hash: '', totalAmount: 0, utxoCount: 0, scriptCount: 0, zeroBalanceScripts: 0, bootstrapHeight: height,
    status: 'bootstrapping', updatedAt: 0,
  };
  const { buildBlockDelta } = jest.requireActual('../../api/supply/supply-delta');
  for (let h = 0; h <= height; h++) {
    await repo.$applyDelta({ height: h - 1, hash: repo.state.hash }, { height: h, hash: chain.main[h] },
      buildBlockDelta(chain.blocks.get(chain.main[h])!.txs));
  }
  repo.state.bootstrapHeight = height;
  repo.applied = [];
  return repo;
}

function makeFollower(chain: FakeChain, repo: MemoryRepository, overrides: Record<string, unknown> = {}) {
  const rpc = {
    getBlockHeader: jest.fn(async (hash: string) => ({ previousblockhash: chain.blocks.get(hash)?.prev })),
    getIndexInfo: jest.fn(async () => ({})),
    getTxoutSetinfo: jest.fn(async () => ({ txouts: repo.state!.utxoCount, total_amount: repo.state!.totalAmount / 1e8 })),
  };
  const bootstrap = { $run: jest.fn(async () => repo.state as SupplyState) };
  let tip = chain.main.length - 1;
  const follower = new SupplyFollower({
    repository: repo as unknown as SupplyDistributionRepository,
    coreApi: chain.coreApi,
    rpc,
    bootstrap,
    tipHeight: () => tip,
    confirmations: 6,
    now: () => 0,
    ...overrides,
  });
  return { follower, rpc, bootstrap, setTip: (height: number) => { tip = height; } };
}

describe('supply follower', () => {
  test('applies blocks up to tip - 6 and marks a confirmed bootstrap ready', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 10);
    const { follower } = makeFollower(chain, repo);
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 14, hash: 'g14', status: 'ready', utxoCount: 15, totalAmount: 15 * COINBASE });
    expect(repo.applied).toEqual(['11:g11', '12:g12', '13:g13', '14:g14']);
  });

  test('waits while the bootstrap snapshot has fewer than 6 confirmations', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 17);
    const { follower, setTip } = makeFollower(chain, repo);
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 17, status: 'bootstrapping' });
    expect(repo.applied).toEqual([]);
    setTip(23);
    chain.main = chain.extend('g', 21, 23);
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 17, status: 'ready' });
  });

  test('undoes blocks that left the main chain, then follows the new branch', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 14);
    repo.state!.status = 'ready';
    // An 8-block reorg replaces heights 12..20 with a longer branch.
    chain.main = chain.extend('r', 12, 22, 'g11');
    const { follower } = makeFollower(chain, repo);
    await follower.$tick();
    expect(repo.applied).toEqual(['13:g13', '12:g12', '11:g11', '12:r12', '13:r13', '14:r14', '15:r15', '16:r16']);
    expect(repo.state).toMatchObject({ height: 16, hash: 'r16', status: 'ready', utxoCount: 17, totalAmount: 17 * COINBASE });

    const fresh = await bootstrapAt(chain, 16);
    expect(repo.rows).toEqual(fresh.rows);
    expect(repo.buckets).toEqual(fresh.buckets);
  });

  test('marks the state stale when a stale block cannot be undone', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 14);
    chain.main = chain.extend('r', 12, 22, 'g11');
    chain.missingPrevouts.add('g14');
    const { follower } = makeFollower(chain, repo);
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 14, hash: 'g14', status: 'stale' });
    await follower.$tick();
    expect(repo.applied).toEqual([]);
  });

  test('verifies totals against coinstatsindex and goes stale on mismatch', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 10);
    const { follower, rpc } = makeFollower(chain, repo);
    rpc.getIndexInfo.mockResolvedValue({ coinstatsindex: { synced: true, best_block_height: 20 } });
    await follower.$tick();
    expect(rpc.getTxoutSetinfo).toHaveBeenCalledTimes(4);
    expect(repo.state?.status).toBe('ready');

    rpc.getTxoutSetinfo.mockResolvedValueOnce({ txouts: 1, total_amount: 0 });
    chain.main = chain.extend('g', 21, 21);
    const second = makeFollower(chain, repo, { rpc });
    await second.follower.$tick();
    expect(repo.state).toMatchObject({ height: 15, status: 'stale' });
  });

  test('bootstraps only when there is no state, at most once per retry window', async () => {
    const chain = new FakeChain(5);
    const repo = new MemoryRepository();
    let now = 0;
    const { follower, bootstrap } = makeFollower(chain, repo, { now: () => now });
    bootstrap.$run.mockRejectedValue(new Error('dump failed'));
    await follower.$tick();
    await follower.$tick();
    expect(bootstrap.$run).toHaveBeenCalledTimes(1);
    now = 6 * 3600_000;
    await follower.$tick();
    expect(bootstrap.$run).toHaveBeenCalledTimes(2);

    const existing = await bootstrapAt(chain, 2);
    const other = makeFollower(chain, existing);
    await other.follower.$tick();
    expect(other.bootstrap.$run).not.toHaveBeenCalled();
  });

  test('a transient failure leaves the height unchanged and is retried', async () => {
    const chain = new FakeChain(20);
    const repo = await bootstrapAt(chain, 10);
    const original = chain.coreApi.$getTxsForBlock;
    chain.coreApi.$getTxsForBlock = jest.fn().mockRejectedValueOnce(new Error('ETIMEDOUT')).mockImplementation(original);
    const { follower } = makeFollower(chain, repo);
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 10, status: 'bootstrapping' });
    await follower.$tick();
    expect(repo.state).toMatchObject({ height: 14, status: 'ready' });
  });
});
