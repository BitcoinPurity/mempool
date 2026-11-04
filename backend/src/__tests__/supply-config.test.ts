import * as fs from 'fs';

function loadConfig(fileConfig: object) {
  let config;
  jest.isolateModules(() => {
    jest.doMock('../../mempool-config.json', () => fileConfig, { virtual: true });
    config = jest.requireActual('../config').default;
  });
  return config;
}

const enabled = { ENABLED: true, SNAPSHOT_DIR: '/var/lib/purity-supply' };

describe('SUPPLY_DISTRIBUTION configuration', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('is disabled by default with a separate database and 6 confirmations', () => {
    expect(loadConfig({}).SUPPLY_DISTRIBUTION).toEqual({
      ENABLED: false,
      DATABASE: 'mempool_supply',
      CONFIRMATIONS: 6,
      TOP_N: 10000,
      SNAPSHOT_DIR: '',
      TEMP_DIR: '',
      DUMP_TIMEOUT: 10800000,
    });
  });

  test('Purity Signet defaults to its own supply database', () => {
    const config = loadConfig({
      MEMPOOL: { NETWORK: 'signet' },
      SUPPLY_DISTRIBUTION: enabled,
    });
    expect(config.SUPPLY_DISTRIBUTION.DATABASE).toBe('mempool_signet_supply');
    expect(() => loadConfig({
      MEMPOOL: { NETWORK: 'signet' },
      SUPPLY_DISTRIBUTION: { ...enabled, DATABASE: 'mempool_supply' },
    })).toThrow(/Signet requires a separate SUPPLY_DISTRIBUTION.DATABASE/);
  });

  test('rejects invalid settings only when enabled', () => {
    expect(() => loadConfig({ SUPPLY_DISTRIBUTION: { SNAPSHOT_DIR: 'relative' } })).not.toThrow();
    const invalid: [object, RegExp][] = [
      [{ ENABLED: true }, /SNAPSHOT_DIR must be an absolute path/],
      [{ ...enabled, SNAPSHOT_DIR: 'relative/dir' }, /SNAPSHOT_DIR must be an absolute path/],
      [{ ...enabled, DATABASE: 'mempool' }, /must differ from DATABASE.DATABASE/],
      [{ ...enabled, DATABASE: 'bad-name;' }, /Invalid SUPPLY_DISTRIBUTION.DATABASE/],
      [{ ...enabled, CONFIRMATIONS: 0 }, /CONFIRMATIONS/],
      [{ ...enabled, TOP_N: 1.5 }, /TOP_N/],
      [{ ...enabled, DUMP_TIMEOUT: 1000 }, /DUMP_TIMEOUT/],
    ];
    for (const [supply, error] of invalid) {
      expect(() => loadConfig({ SUPPLY_DISTRIBUTION: supply })).toThrow(error);
    }
    expect(() => loadConfig({ DATABASE: { ENABLED: false }, SUPPLY_DISTRIBUTION: enabled })).toThrow(/requires DATABASE.ENABLED/);
  });

  test('sample and Docker configuration expose the settings', () => {
    const sample = JSON.parse(fs.readFileSync(`${__dirname}/../../mempool-config.sample.json`, 'utf8'));
    expect(sample.SUPPLY_DISTRIBUTION).toMatchObject({ ENABLED: false, DATABASE: 'mempool_supply', CONFIRMATIONS: 6 });
    const startSh = fs.readFileSync(`${__dirname}/../../../docker/backend/start.sh`, 'utf8');
    expect(startSh).toContain('__SUPPLY_DISTRIBUTION_ENABLED__=${SUPPLY_DISTRIBUTION_ENABLED:=false}');
    expect(startSh).toContain('__SUPPLY_DISTRIBUTION_CONFIRMATIONS__=${SUPPLY_DISTRIBUTION_CONFIRMATIONS:=6}');
  });
});
