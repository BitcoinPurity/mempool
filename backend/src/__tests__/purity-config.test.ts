import { OFFICIAL_SIGNET, resolvePurityConfig } from '../purity-config';

describe('network consensus profiles', () => {
  test('preserves deployed Mainnet defaults and existing overrides', () => {
    const main = resolvePurityConfig('mainnet');
    expect(main.ACTIVATION_HEIGHT).toBe(961636);
    expect(main.ASERT_ANCHOR_HEIGHT).toBe(961632);
    expect(main.POW_LIMIT).toBe('00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    expect(resolvePurityConfig('mainnet', { ACTIVATION_HEIGHT: 961637 }).ACTIVATION_HEIGHT).toBe(961637);
  });
  test('selects official Signet without inheriting Mainnet defaults', () => {
    expect(resolvePurityConfig('signet')).toEqual(OFFICIAL_SIGNET);
    expect(resolvePurityConfig('signet', { ...OFFICIAL_SIGNET })).toEqual(OFFICIAL_SIGNET);
    expect(OFFICIAL_SIGNET).toMatchObject({ ACTIVATION_HEIGHT: 327022, ASERT_ANCHOR_HEIGHT: 327017,
      ASERT_ANCHOR_BITS: 0x1d154f9b, ASERT_ANCHOR_PARENT_TIME: 1792401042,
      ASERT_HALF_LIFE: 86400, POW_TARGET_SPACING: 600 });
  });
  test.each([
    { ACTIVATION_HEIGHT: 961636 }, { ASERT_ANCHOR_HEIGHT: 961632 }, { ACTIVATION_HEIGHT: 327017 },
    { ACTIVATION_HEIGHT: 327022.5 }, { ASERT_ANCHOR_HEIGHT: -1 }, { ASERT_HALF_LIFE: 0 },
    { POW_TARGET_SPACING: 0 }, { ASERT_ANCHOR_BITS: 0x1d954f9b }, { ASERT_ANCHOR_PARENT_TIME: 0 },
    { POW_LIMIT: '00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    { POW_LIMIT: 'not-hex' }, { POW_LIMIT: '0'.repeat(64) }, { ACTIVATION_HASH: '0'.repeat(64) },
  ])('rejects invalid or nonofficial Signet profile %j', override => {
    expect(() => resolvePurityConfig('signet', override)).toThrow(/PURITY/);
  });
  test.each([{ ACTIVATION_HEIGHT: 1 }, { ASERT_ANCHOR_HEIGHT: -1 }, { ASERT_HALF_LIFE: 0 }])(
    'rejects invalid dependencies on Mainnet %j', override => {
      expect(() => resolvePurityConfig('mainnet', override)).toThrow(/PURITY/);
    }
  );
});

describe('separate backend processes', () => {
  afterEach(() => jest.dontMock('../../mempool-config.json'));
  function load(network: string, extra = {}) {
    jest.resetModules();
    jest.doMock('../../mempool-config.json', () => ({ MEMPOOL: { NETWORK: network }, ...extra }), { virtual: true });
    return require('../config').default;
  }
  test('uses separate cache, database, RPC, Electrum, port and PID namespace by default', () => {
    const main = load('mainnet');
    const signet = load('signet');
    expect(main.MEMPOOL.CACHE_DIR).toBe('./cache');
    expect(main.DATABASE.DATABASE).toBe('mempool');
    expect(main.MEMPOOL.HTTP_PORT).toBe(8999);
    expect(signet.MEMPOOL.CACHE_DIR).toBe('./cache/signet');
    expect(signet.DATABASE.DATABASE).toBe('mempool_signet');
    expect(signet.MEMPOOL.HTTP_PORT).toBe(8998);
    expect(signet.CORE_RPC.PORT).toBe(38332);
    expect(signet.CORE_RPC.COOKIE_PATH).toBe('/bitcoin/signet/.cookie');
    expect(signet.SECOND_CORE_RPC.PORT).toBe(38332);
    expect(signet.SECOND_CORE_RPC.COOKIE_PATH).toBe('/bitcoin/signet/.cookie');
    expect(signet.ELECTRUM.PORT).toBe(60601);
    expect(signet.ELECTRUM.TLS_ENABLED).toBe(false);
    expect(signet.PURITY).toEqual(OFFICIAL_SIGNET);
  });
  test.each([
    { DATABASE: { DATABASE: 'mempool' } },
    { MEMPOOL: { NETWORK: 'signet', CACHE_DIR: './cache' } },
    { PURITY: { ACTIVATION_HEIGHT: 961636, ASERT_ANCHOR_HEIGHT: 961632 } },
  ])('rejects accidental Mainnet state or consensus reuse %j', extra => {
    expect(() => load('signet', extra)).toThrow();
  });
});
