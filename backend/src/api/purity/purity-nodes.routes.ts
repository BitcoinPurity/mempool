import { Application, Request, Response } from 'express';
import axios from 'axios';
import { isIP } from 'net';
import * as IPCheck from '../../utils/ipcheck.js';
import config from '../../config';
import logger from '../../logger';
import purityNodesApi, { PurityNodesApi, PurityNodesError } from './purity-nodes.api';

const NON_PUBLIC_IPV4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];

function canonicalIp(host: string): string {
  return isIP(host) === 6 && !host.includes('%') ? new URL('http://[' + host + ']').hostname.slice(1, -1) : host;
}

export function isPublicIp(host: string): boolean {
  if (!isIP(host) || host.includes('%')) {
    return false;
  }
  host = canonicalIp(host);
  if (isIP(host) === 4 || IPCheck.match(host, '::ffff:0:0/96')) {
    return !NON_PUBLIC_IPV4.some(range => IPCheck.match(host, range));
  }
  return IPCheck.match(host, '2000::/3') &&
    !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(range => IPCheck.match(host, range));
}

export class PurityNodesRoutes {
  private submissionExpiry = new Map<string, number>();
  private activeSubmissions = 0;

  constructor(private api: PurityNodesApi = purityNodesApi) { }

  initRoutes(app: Application): void {
    app.get(config.MEMPOOL.API_URL_PREFIX + 'purity/nodes', this.getNodes.bind(this))
      .post(config.MEMPOOL.API_URL_PREFIX + 'purity/nodes', this.addNode.bind(this));
  }

  private async getNodes(_req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await this.api.getNodes());
    } catch (error) {
      this.sendError(res, error, false);
    }
  }

  private async addNode(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const host = typeof req.body?.host === 'string' ? req.body.host.trim() : '';
    const port = req.body?.port === undefined ? 8333 : req.body.port;
    if (!isPublicIp(host)) {
      res.status(400).json({ error: 'public_ip_required' });
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: 'invalid_port' });
      return;
    }

    const remote = req.socket.remoteAddress ? canonicalIp(req.socket.remoteAddress) : undefined;
    const trusted = !remote || config.PURITY_SEEDER.TRUSTED_PROXIES.some(range => IPCheck.match(remote, range));
    const forwarded = trusted ? req.get('X-Real-IP') : undefined;
    const source = forwarded && isIP(forwarded) && !forwarded.includes('%') ? canonicalIp(forwarded) : remote ?? 'unix-socket';
    const now = Date.now();
    for (const [key, expiry] of this.submissionExpiry) {
      if (expiry <= now) { this.submissionExpiry.delete(key); }
    }
    const expiry = this.submissionExpiry.get(source);
    if (expiry) {
      res.setHeader('Retry-After', Math.ceil((expiry - now) / 1000));
      res.status(429).json({ error: 'submission_rate_limited' });
      return;
    }
    if (this.activeSubmissions >= 2) {
      res.setHeader('Retry-After', 1);
      res.status(429).json({ error: 'verification_busy' });
      return;
    }
    this.submissionExpiry.set(source, now + 60000);
    this.activeSubmissions++;
    try {
      res.json(await this.api.addNode(host, port));
    } catch (error) {
      this.sendError(res, error, true);
    } finally {
      this.activeSubmissions--;
    }
  }

  private sendError(res: Response, error: unknown, submission: boolean): void {
    const timedOut = axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? '');
    const status = error instanceof PurityNodesError ? error.statusCode : timedOut ? 504 : 502;
    const code = error instanceof PurityNodesError ? error.code : timedOut ?
      (submission ? 'verification_timeout' : 'inventory_timeout') : 'seeder_unavailable';
    logger.warn(`Purity node API request failed (${code}, HTTP ${status})`);
    res.status(status).json({ error: code });
  }
}

export default new PurityNodesRoutes();
