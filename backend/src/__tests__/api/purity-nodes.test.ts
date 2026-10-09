import axios from 'axios';
import maxmind from 'maxmind';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import config from '../../config';
import { PurityNodesApi } from '../../api/purity/purity-nodes.api';
import { PurityNodesRoutes, isPublicIp } from '../../api/purity/purity-nodes.routes';

jest.mock('axios');
jest.mock('maxmind', () => ({ __esModule: true, default: { open: jest.fn() } }));

const upstreamNode = {
  host: '8.8.8.8', port: 8333, status: 'purity', p2p_reachable: 1,
  user_agent: '/Purity:1.0.0/', height: 962000,
  last_seen: 1700000000, last_success: 1700000000, last_p2p_success: 1700000000,
};
const city = {
  location: { longitude: -74, latitude: 40.7 },
  city: { names: { en: 'New York' } },
  country: { names: { en: 'United States' }, iso_code: 'US' },
};

describe('Purity node inventory and public submissions', () => {
  const originalToken = process.env.PURITY_SEEDER_API_TOKEN;
  const lookup = jest.fn();
  let api: PurityNodesApi;
  let handlers: Record<string, (req: any, res: any) => Promise<void>>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(1700000100000);
    process.env.PURITY_SEEDER_API_TOKEN = 'test-only-token';
    config.PURITY_SEEDER.TRUSTED_PROXIES = ['127.0.0.1/32', '::1/128'];
    lookup.mockReturnValue(city);
    (maxmind.open as jest.Mock).mockResolvedValue({ get: lookup });
    (axios.get as jest.Mock).mockResolvedValue({ data: [upstreamNode] });
    (axios.post as jest.Mock).mockResolvedValue({ data: {
      host: '8.8.8.8', port: 8333, added: true, verification: 'purity', status: 'purity',
    } });
    (axios.isAxiosError as unknown as jest.Mock).mockImplementation(error => error?.isAxiosError === true);
    api = new PurityNodesApi();
    handlers = {};
    const app: any = {};
    app.get = (path, handler) => { handlers['GET ' + path] = handler; return app; };
    app.post = (path, handler) => { handlers['POST ' + path] = handler; return app; };
    new PurityNodesRoutes(api).initRoutes(app);
  });

  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    if (originalToken === undefined) { delete process.env.PURITY_SEEDER_API_TOKEN; }
    else { process.env.PURITY_SEEDER_API_TOKEN = originalToken; }
  });

  async function request(method: string, body?: unknown, remote = '8.8.4.4', forwarded?: string) {
    const res: any = { statusCode: 200, headers: {} };
    res.status = (status: number) => { res.statusCode = status; return res; };
    res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res; };
    res.json = (data: unknown) => { res.body = data; return res; };
    await handlers[method + ' /api/v1/purity/nodes']({
      body, socket: { remoteAddress: remote }, get: () => forwarded,
    }, res);
    return res;
  }

  test('returns only confirmed endpoints with location and exact P2P observations', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: [
      upstreamNode,
      { ...upstreamNode, port: 8334, p2p_reachable: 0 },
      { ...upstreamNode, host: '2001:4860:4860::8888', p2p_reachable: null },
      { ...upstreamNode, status: 'purity_candidate' },
      { ...upstreamNode, status: 'other' },
    ] });
    const res = await request('GET');
    expect(res.statusCode).toBe(200);
    expect(res.body.updated_at).toBe(1700000100);
    expect(res.body.nodes.map(n => n.p2p_reachable)).toEqual([1, 0, null]);
    expect(res.body.nodes[0].location).toEqual({ longitude: -74, latitude: 40.7,
      city: 'New York', country: 'United States', country_code: 'US' });
    expect(axios.get).toHaveBeenCalledWith('https://seed.bitcoinpurity.org/api/listnodes', expect.objectContaining({
      timeout: 15000, headers: { Authorization: 'Bearer test-only-token' }, maxRedirects: 0,
    }));
    expect(JSON.stringify(res.body)).not.toContain('test-only-token');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('retains nodes with unknown coordinates and handles zero coordinates', async () => {
    lookup.mockReturnValueOnce(null).mockReturnValueOnce({ location: { longitude: 0, latitude: 0 } });
    (axios.get as jest.Mock).mockResolvedValue({ data: [upstreamNode, { ...upstreamNode, port: 8334 }] });
    const result = await api.getNodes();
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].location).toBeNull();
    expect(result.nodes[1].location).toEqual({ longitude: 0, latitude: 0, city: null, country: null, country_code: null });
  });

  test.each([
    [33554433, 'archive'], [33555456, 'prune'], [33555457, 'archive'],
    [1, 'archive'], [1024, 'prune'], [1025, 'archive'],
    [33554432, 'unknown'], [0, 'unknown'], [undefined, 'unknown'], [null, 'unknown'],
    ['1024', 'unknown'], [-1, 'unknown'], [1.5, 'unknown'], [Number.MAX_SAFE_INTEGER + 1, 'unknown'],
  ])('classifies services %s independently of reachability as %s', async (services, nodeType) => {
    (axios.get as jest.Mock).mockResolvedValue({ data: [1, 0, null].map((p2p_reachable, index) => ({
      ...upstreamNode, port: 8333 + index, p2p_reachable, services,
    })) });
    const res = await request('GET');
    expect(res.statusCode).toBe(200);
    expect(res.body.nodes.map(node => node.node_type)).toEqual([nodeType, nodeType, nodeType]);
    expect(res.body.nodes.map(node => node.p2p_reachable)).toEqual([1, 0, null]);
  });

  test('shares simultaneous reads and expires the snapshot after 60 seconds', async () => {
    await Promise.all([api.getNodes(), api.getNodes(), api.getNodes()]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(59999);
    await api.getNodes();
    expect(axios.get).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await api.getNodes();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(maxmind.open).toHaveBeenCalledTimes(1);
  });

  test.each(['purity', 'other', 'inconclusive'])('passes verification %s and invalidates the snapshot', async verification => {
    await api.getNodes();
    (axios.post as jest.Mock).mockResolvedValue({ data: {
      host: '8.8.8.8', port: 8333, added: false, verification, status: verification === 'other' ? 'other' : 'purity',
    } });
    const res = await request('POST', { host: '8.8.8.8' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ added: false, verification });
    expect(axios.post).toHaveBeenCalledWith('https://seed.bitcoinpurity.org/api/addnode', { host: '8.8.8.8', port: 8333 },
      expect.objectContaining({ timeout: 60000, maxRedirects: 0 }));
    await api.getNodes();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('an older in-flight inventory cannot overwrite the snapshot after a submission', async () => {
    let finishOld: (value: unknown) => void;
    (axios.get as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const oldRead = api.getNodes();
    await Promise.resolve();
    await request('POST', { host: '8.8.8.8' });
    (axios.get as jest.Mock).mockResolvedValue({ data: [{ ...upstreamNode, port: 8334 }] });
    await api.getNodes();
    finishOld!({ data: [upstreamNode] });
    await oldRead;
    expect((await api.getNodes()).nodes[0].port).toBe(8334);
  });

  test.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:808:808', '2001:4860::8.8.8.8'])
  ('accepts public IP %s', async host => {
    expect(isPublicIp(host)).toBe(true);
    expect((await request('POST', { host, port: 8334 })).statusCode).toBe(200);
  });

  test.each(['localhost', 'seed.bitcoinpurity.org', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1',
    '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1',
    '198.18.0.1', '198.51.100.1', '203.0.113.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001:db8::1', '3fff::1', '2002:7f00:1::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:192.168.1.1', '2001:4860:4860::8888%lo0', '2001:db8::8.8.8.8', 'fc00::8.8.8.8',
    '64:ff9b::8.8.8.8'])('rejects non-public target %s', async host => {
    expect(isPublicIp(host)).toBe(false);
    expect((await request('POST', { host })).statusCode).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test.each([0, 65536, -1, 8333.5, '8333', true, null])('rejects invalid port %s', async port => {
    expect((await request('POST', { host: '8.8.8.8', port })).statusCode).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rate limits untrusted clients without accepting a forged proxy header', async () => {
    expect((await request('POST', { host: '8.8.8.8' }, '1.1.1.1', '8.8.4.4')).statusCode).toBe(200);
    const limited = await request('POST', { host: '8.8.8.8' }, '1.1.1.1', '9.9.9.9');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['Retry-After']).toBe(60);
    jest.advanceTimersByTime(60000);
    expect((await request('POST', { host: '8.8.8.8' }, '1.1.1.1')).statusCode).toBe(200);
  });

  test('uses distinct client IPs only behind explicitly trusted proxies', async () => {
    expect((await request('POST', { host: '8.8.8.8' }, '::ffff:127.0.0.1', '1.1.1.1')).statusCode).toBe(200);
    expect((await request('POST', { host: '8.8.8.8' }, '::ffff:127.0.0.1', '8.8.4.4')).statusCode).toBe(200);
    expect((await request('POST', { host: '8.8.8.8' }, '::ffff:127.0.0.1', '1.1.1.1')).statusCode).toBe(429);
  });

  test('the local trusted proxy overwrites a forged client IP', () => {
    const sandbox = { module: { exports: [] as any[] }, console: { log: jest.fn() },
      require: () => ({ readFileSync: () => '{"BASE_MODULE":"mempool"}' }) };
    runInNewContext(readFileSync(join(__dirname, '../../../../frontend/proxy.conf.local.js'), 'utf8'), sandbox);
    const proxy = sandbox.module.exports.find(entry => entry.context.includes('/api/v1/purity/nodes'));
    const setHeader = jest.fn();
    proxy.onProxyReq({ setHeader }, { socket: { remoteAddress: '::ffff:8.8.4.4' },
      headers: { 'x-real-ip': '1.1.1.1' } });
    expect(setHeader).toHaveBeenCalledWith('X-Real-IP', '::ffff:8.8.4.4');
    expect(proxy.proxyTimeout).toBe(70000);
  });

  test('bounds concurrent verifications and releases the slot after failure', async () => {
    let rejectFirst: (error: unknown) => void;
    let finishSecond: (result: unknown) => void;
    (axios.post as jest.Mock)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
    const first = request('POST', { host: '8.8.8.8' }, '1.1.1.1');
    const second = request('POST', { host: '8.8.8.8' }, '8.8.4.4');
    expect((await request('POST', { host: '8.8.8.8' }, '9.9.9.9')).statusCode).toBe(429);
    rejectFirst!(new Error('failure'));
    expect((await first).statusCode).toBe(502);
    finishSecond!({ data: { host: '8.8.8.8', port: 8333, added: true, verification: 'purity', status: 'purity' } });
    await second;
    expect((await request('POST', { host: '8.8.8.8' }, '9.9.9.9')).statusCode).toBe(200);
  });

  test('reports missing credentials and unavailable location database without leaking secrets', async () => {
    delete process.env.PURITY_SEEDER_API_TOKEN;
    expect((await request('GET')).statusCode).toBe(503);
    expect(axios.get).not.toHaveBeenCalled();
    process.env.PURITY_SEEDER_API_TOKEN = 'test-only-token';
    (maxmind.open as jest.Mock).mockRejectedValue(new Error('database unavailable'));
    expect((await request('GET')).statusCode).toBe(503);
    (maxmind.open as jest.Mock).mockResolvedValue({ get: lookup });
    expect((await request('GET')).statusCode).toBe(200);
  });

  test('sanitizes upstream authentication errors', async () => {
    (axios.get as jest.Mock).mockRejectedValue({ isAxiosError: true, response: { status: 401 },
      config: { headers: { Authorization: 'Bearer test-only-token' } } });
    const res = await request('GET');
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'seeder_unavailable' });
  });

  test('does not cache malformed inventory or invalid P2P states', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: [{ ...upstreamNode, p2p_reachable: 2 }] });
    expect((await request('GET')).statusCode).toBe(502);
    expect((await request('GET')).statusCode).toBe(502);
    expect((await request('GET')).statusCode).toBe(200);
  });

  test('reports verification timeout, invalidates data, and never retries a write', async () => {
    await api.getNodes();
    (axios.post as jest.Mock).mockRejectedValue({ isAxiosError: true, code: 'ECONNABORTED' });
    const res = await request('POST', { host: '8.8.8.8' });
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: 'verification_timeout' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    await api.getNodes();
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('reports inventory timeout without caching a failed request', async () => {
    (axios.get as jest.Mock).mockRejectedValueOnce({ isAxiosError: true, code: 'ETIMEDOUT' });
    const res = await request('GET');
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: 'inventory_timeout' });
    expect((await request('GET')).statusCode).toBe(200);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('rejects malformed submission results without exposing upstream fields', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: { verification: 'unexpected', token: 'test-only-token' } });
    const res = await request('POST', { host: '8.8.8.8' });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'invalid_seeder_response' });
  });
});
