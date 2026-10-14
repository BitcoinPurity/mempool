import * as http from 'http';
import { AddressInfo, Socket } from 'net';

const { JsonRPC } = require('../../rpc-api/jsonrpc');

describe('JsonRPC HTTP response lifecycle', () => {
  let server: http.Server;
  let sockets: Set<Socket>;
  let timers: NodeJS.Timeout[];
  let handleRequest: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  let port: number;

  beforeEach(async () => {
    sockets = new Set();
    timers = [];
    server = http.createServer((request, response) => {
      request.resume();
      handleRequest(request, response);
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    timers.forEach(timer => clearTimeout(timer));
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    jest.restoreAllMocks();
  });

  test('enforces the total timeout while the response keeps sending chunks', async () => {
    let chunks = 0;
    let closed = false;
    handleRequest = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"result":');
      response.on('close', () => { closed = true; });
      timers.push(setInterval(() => {
        chunks++;
        response.write(' ');
      }, 20));
    };
    const rpc = new JsonRPC({ host: '127.0.0.1', port, timeout: 150 });
    const deadline = new Promise((_resolve, reject) => {
      timers.push(setTimeout(() => reject(new Error('RPC remained pending beyond its total timeout')), 1000));
    });

    await expect(Promise.race([rpc.call('getrawmempool', [true]), deadline]))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(chunks).toBeGreaterThan(1);
    await new Promise(resolve => { timers.push(setTimeout(resolve, 30)); });
    expect(closed).toBe(true);
  });

  test('rejects a truncated response promptly instead of waiting for the total timeout', async () => {
    handleRequest = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"result":');
      timers.push(setTimeout(() => response.destroy(), 20));
    };
    const rpc = new JsonRPC({ host: '127.0.0.1', port, timeout: 1000 });
    const deadline = new Promise((_resolve, reject) => {
      timers.push(setTimeout(() => reject(new Error('Interrupted RPC remained pending')), 500));
    });

    await expect(Promise.race([rpc.call('getrawmempool', [true]), deadline]))
      .rejects.toMatchObject({ code: 'ECONNRESET' });

    handleRequest = (_request, response) => response.end('{"result":{"recovered":true}}');
    await expect(rpc.call('getrawmempool', [true])).resolves.toEqual({ recovered: true });
  });

  test.each([
    { name: 'single result', body: '{"result":{"transactions":4}}', expected: { result: { transactions: 4 } } },
    { name: 'batch result', body: '[{"result":4}]', expected: { result: 4 } },
    { name: 'RPC error', body: '{"error":{"code":-5,"message":"not found"}}', expected: { error: { code: -5 } } },
    { name: 'invalid JSON', body: '{"result":', expected: { error: { code: -32603 } } },
  ])('preserves $name and clears the total timer after a complete response', async ({ body, expected }) => {
    handleRequest = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(body.slice(0, 5));
      timers.push(setTimeout(() => response.end(body.slice(5)), 20));
    };
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const rpc = new JsonRPC({ host: '127.0.0.1', port, timeout: 1000 });
    const pending = rpc.call('getrawmempool', [true]);
    const totalTimer = setTimeoutSpy.mock.results[0].value;

    await expect(pending.then(result => ({ result }), error => ({ error: { code: error.code } })))
      .resolves.toEqual(expected);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(totalTimer);
  });

  test('still times out when the server sends no response headers', async () => {
    handleRequest = () => {};
    const rpc = new JsonRPC({ host: '127.0.0.1', port, timeout: 150 });

    await expect(rpc.call('getrawmempool', [true])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
});
