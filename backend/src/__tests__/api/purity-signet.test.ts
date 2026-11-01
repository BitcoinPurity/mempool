import { PuritySignetValidator } from '../../api/purity-signet';
import { OFFICIAL_SIGNET } from '../../purity-config';

describe('Purity Signet identity guard', () => {
  const core = { getBlockchainInfo: jest.fn(), getBlockHash: jest.fn() };
  const indexer = jest.fn();
  beforeEach(() => {
    jest.resetAllMocks();
    core.getBlockchainInfo.mockResolvedValue({ chain: 'signet', blocks: 327023 });
    core.getBlockHash.mockResolvedValue(OFFICIAL_SIGNET.ACTIVATION_HASH);
    indexer.mockResolvedValue('verified');
  });
  test('requires official activation hash on RPC and indexer', async () => {
    const guard = new PuritySignetValidator(core, indexer);
    await expect(guard.validate()).resolves.toBe('verified');
    expect(guard.ready).toBe(true);
    expect(core.getBlockHash).toHaveBeenCalledWith(327022);
    expect(indexer).toHaveBeenCalledTimes(1);
  });
  test('does not treat chain=signet as proof of Purity identity', async () => {
    core.getBlockHash.mockResolvedValue('wrong-chain');
    const guard = new PuritySignetValidator(core, indexer);
    await expect(guard.validate()).rejects.toThrow(/activation hash/);
    expect(guard.ready).toBe(false);
  });
  test('permits IBD below activation with identity pending and checks on crossing', async () => {
    core.getBlockchainInfo.mockResolvedValue({ chain: 'signet', blocks: 327021, headers: 400000, initialblockdownload: true });
    indexer.mockResolvedValue('pending');
    const guard = new PuritySignetValidator(core, indexer);
    await expect(guard.validate()).resolves.toBe('pending');
    expect(guard.ready).toBe(true);
    expect(core.getBlockHash).not.toHaveBeenCalled();
    core.getBlockchainInfo.mockResolvedValue({ chain: 'signet', blocks: 327022 });
    core.getBlockHash.mockResolvedValue('bitcoin-core-signet');
    await expect(guard.validate()).rejects.toThrow();
    expect(guard.ready).toBe(false);
  });
  test('rechecks verified chains and blocks stale data after a mismatch or RPC failure', async () => {
    const guard = new PuritySignetValidator(core, indexer);
    await guard.validate();
    core.getBlockHash.mockResolvedValue('reorg');
    await expect(guard.validate()).rejects.toThrow();
    expect(guard.ready).toBe(false);
    core.getBlockHash.mockRejectedValue(new Error('offline'));
    await expect(guard.validate()).rejects.toThrow('offline');
    expect(guard.ready).toBe(false);
  });
  test('permits a lagging indexer but rejects an incorrect indexer', async () => {
    const guard = new PuritySignetValidator(core, indexer);
    indexer.mockResolvedValue('pending');
    await expect(guard.validate()).resolves.toBe('pending');
    indexer.mockRejectedValue(new Error('Electrum activation hash mismatch'));
    await expect(guard.validate()).rejects.toThrow(/Electrum/);
    expect(guard.ready).toBe(false);
  });
  test('rejects a different RPC network even during IBD', async () => {
    core.getBlockchainInfo.mockResolvedValue({ chain: 'main', blocks: 1 });
    await expect(new PuritySignetValidator(core, indexer).validate()).rejects.toThrow(/signet/);
  });
});
