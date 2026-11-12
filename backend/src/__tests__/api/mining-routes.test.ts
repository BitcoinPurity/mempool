import { RequestHandler } from 'express';
import miningRoutes from '../../api/mining/mining-routes';
import mining from '../../api/mining/mining';
import DB from '../../database';

jest.mock('../../api/mining/mining', () => ({ $getPoolsStats: jest.fn() }));
jest.mock('../../database', () => ({ query: jest.fn() }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({}));
jest.mock('../../api/chain-tips', () => ({}));
jest.mock('../../api/blocks', () => ({}));
jest.mock('../../api/transaction-utils', () => ({}));
jest.mock('../../api/services/acceleration', () => ({}));
jest.mock('../../tasks/pools-updater', () => ({}));
jest.mock('../../repositories/PricesRepository', () => ({}));

const getPoolsStats = jest.mocked(mining.$getPoolsStats);
const query = DB.query as jest.Mock;
const stats = { pools: [], blockCount: 42 };

function setup() {
  const Routes = miningRoutes.constructor as new () => typeof miningRoutes;
  const app = { get: jest.fn().mockReturnThis(), post: jest.fn().mockReturnThis() };
  new Routes().initRoutes(app as unknown as Parameters<typeof miningRoutes.initRoutes>[0]);
  const handler: RequestHandler = app.get.mock.calls.find(([path]) => path === '/api/v1/mining/pools/:interval')[1];

  return async (interval = '1m') => {
    const headers: Record<string, string> = {};
    const res = {
      status: jest.fn().mockReturnThis(),
      header: (key: string, value: string) => { headers[key] = value; },
      setHeader: (key: string, value: string) => { headers[key] = value; },
      json: jest.fn(),
    };
    await handler({ params: { interval }, accepts: () => 'json' } as unknown as Parameters<RequestHandler>[0],
      res as unknown as Parameters<RequestHandler>[1], jest.fn());
    return { ...res, headers };
  };
}

describe('mining pool statistics', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-12T02:00:00Z') });
    getPoolsStats.mockReset().mockResolvedValue(stats);
    query.mockReset().mockResolvedValue([[{ blockCount: 329052 }]]);
  });

  afterEach(() => jest.useRealTimers());

  test('counts canonical blocks with COUNT(*)', async () => {
    const request = setup();
    const res = await request();
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/SELECT count\(\*\) as blockCount\s+FROM blocks\s+WHERE stale = 0/i), []);
    expect(res.headers['X-total-count']).toBe('329052');
  });

  test('shares a pending monthly response, then caches its body and count for 60 seconds', async () => {
    const request = setup();
    let finish!: (value: object) => void;
    getPoolsStats.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));

    const first = request();
    jest.advanceTimersByTime(65_000);
    const concurrent = request();
    finish(stats);
    const expires = new Date(Date.now() + 60_000).toUTCString();

    for (const res of await Promise.all([first, concurrent])) {
      expect(res.json).toHaveBeenCalledWith(stats);
      expect(res.headers['X-total-count']).toBe('329052');
      expect(res.headers['Cache-control']).toBe('public, max-age=60');
      expect(res.headers.Expires).toBe(expires);
    }

    jest.advanceTimersByTime(59_000);
    const cached = await request();
    expect(cached.json).toHaveBeenCalledWith(stats);
    expect(cached.headers['X-total-count']).toBe('329052');
    expect(cached.headers['Cache-control']).toBe('public, max-age=1');
    expect(cached.headers.Expires).toBe(expires);
    expect(getPoolsStats).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    const freshStats = { ...stats, blockCount: 43 };
    getPoolsStats.mockResolvedValueOnce(freshStats);
    query.mockResolvedValueOnce([[{ blockCount: 329053 }]]);
    const refreshed = await request();
    expect(refreshed.json).toHaveBeenCalledWith(freshStats);
    expect(refreshed.headers['X-total-count']).toBe('329053');
    expect(getPoolsStats).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('retries a failed refresh and keeps other intervals independent', async () => {
    const request = setup();
    query.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await request()).status).toHaveBeenCalledWith(500);
    expect((await request()).json).toHaveBeenCalledWith(stats);

    await request('1w');
    await request('1w');
    expect(getPoolsStats.mock.calls).toEqual([['1m'], ['1m'], ['1w'], ['1w']]);
  });
});
