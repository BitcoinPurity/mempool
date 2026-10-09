import axios from 'axios';
import maxmind, { CityResponse } from 'maxmind';
import { Reader } from 'mmdb-lib';
import { isIP } from 'net';
import config from '../../config';

export interface PurityNode {
  host: string;
  port: number;
  status: 'purity';
  p2p_reachable: 0 | 1 | null;
  node_type: 'archive' | 'prune' | 'unknown';
  user_agent: string;
  height: number;
  last_seen: number;
  last_success: number;
  last_p2p_success: number;
  location: {
    longitude: number;
    latitude: number;
    city: string | null;
    country: string | null;
    country_code: string | null;
  } | null;
}

export interface PurityNodeSnapshot {
  updated_at: number;
  nodes: PurityNode[];
}

export interface PurityNodeSubmission {
  host: string;
  port: number;
  added: boolean;
  verification: 'purity' | 'other' | 'inconclusive';
  status: string;
}

export class PurityNodesError extends Error {
  constructor(public statusCode: number, public code: string) {
    super(code);
  }
}

export class PurityNodesApi {
  private snapshot: PurityNodeSnapshot | null = null;
  private expiresAt = 0;
  private generation = 0;
  private pending: Promise<PurityNodeSnapshot> | null = null;
  private cityReader: Promise<Reader<CityResponse>> | null = null;

  getNodes(): Promise<PurityNodeSnapshot> {
    if (this.snapshot && Date.now() < this.expiresAt) {
      return Promise.resolve(this.snapshot);
    }
    if (this.pending) {
      return this.pending;
    }

    const generation = this.generation;
    const request = this.loadNodes().then(snapshot => {
      // A submission can finish while an older list request is still running.
      if (generation === this.generation) {
        this.snapshot = snapshot;
        this.expiresAt = Date.now() + 60000;
      }
      return snapshot;
    }).finally(() => {
      if (this.pending === request) {
        this.pending = null;
      }
    });
    this.pending = request;
    return request;
  }

  async addNode(host: string, port: number): Promise<PurityNodeSubmission> {
    const headers = this.authorization();
    try {
      const { data } = await axios.post<PurityNodeSubmission>(
        config.PURITY_SEEDER.API_URL.replace(/\/+$/, '') + '/api/addnode',
        { host, port },
        { headers, timeout: 60000, maxRedirects: 0 },
      );
      if (!data || typeof data.host !== 'string' || !isIP(data.host) || !Number.isInteger(data.port) ||
          data.port < 1 || data.port > 65535 || typeof data.added !== 'boolean' ||
          !['purity', 'other', 'inconclusive'].includes(data.verification) ||
          !['new', 'purity', 'purity_candidate', 'other', 'failed'].includes(data.status)) {
        throw new PurityNodesError(502, 'invalid_seeder_response');
      }
      return { host: data.host, port: data.port, added: data.added,
        verification: data.verification, status: data.status };
    } finally {
      // A timeout can occur after the Seeder has already changed its inventory.
      this.generation++;
      this.snapshot = null;
      this.pending = null;
    }
  }

  private authorization(): { Authorization: string } {
    const token = process.env.PURITY_SEEDER_API_TOKEN;
    if (!token) {
      throw new PurityNodesError(503, 'seeder_not_configured');
    }
    return { Authorization: 'Bearer ' + token };
  }

  /** @asyncUnsafe */
  private async loadNodes(): Promise<PurityNodeSnapshot> {
    const headers = this.authorization();
    if (!this.cityReader) {
      this.cityReader = maxmind.open<CityResponse>(config.MAXMIND.GEOLITE2_CITY).catch(() => {
        this.cityReader = null;
        throw new PurityNodesError(503, 'geolocation_unavailable');
      });
    }
    const reader = await this.cityReader;
    const { data } = await axios.get<unknown>(
      config.PURITY_SEEDER.API_URL.replace(/\/+$/, '') + '/api/listnodes',
      { headers, timeout: 15000, maxRedirects: 0 },
    );
    if (!Array.isArray(data)) {
      throw new PurityNodesError(502, 'invalid_seeder_response');
    }

    const nodes: PurityNode[] = [];
    for (const node of data) {
      if (node?.status !== 'purity') {
        continue;
      }
      if (typeof node.host !== 'string' || !isIP(node.host) || !Number.isInteger(node.port) ||
          node.port < 1 || node.port > 65535 || ![0, 1, null].includes(node.p2p_reachable) ||
          typeof node.user_agent !== 'string' ||
          ![node.height, node.last_seen, node.last_success, node.last_p2p_success].every(Number.isFinite)) {
        throw new PurityNodesError(502, 'invalid_seeder_response');
      }
      const city = reader.get(node.host);
      const longitude = city?.location?.longitude;
      const latitude = city?.location?.latitude;
      const location = typeof longitude === 'number' && typeof latitude === 'number' &&
        Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? {
          longitude, latitude, city: city?.city?.names?.en ?? null,
          country: city?.country?.names?.en ?? null, country_code: city?.country?.iso_code ?? null,
        } : null;
      const services = Number.isSafeInteger(node.services) && node.services >= 0 ? node.services : 0;
      // NODE_NETWORK takes precedence when NODE_NETWORK_LIMITED is also advertised (BIP159).
      const nodeType = services & 1 ? 'archive' : services & 1024 ? 'prune' : 'unknown';
      nodes.push({ host: node.host, port: node.port, status: 'purity', p2p_reachable: node.p2p_reachable, node_type: nodeType,
        user_agent: node.user_agent, height: node.height, last_seen: node.last_seen,
        last_success: node.last_success, last_p2p_success: node.last_p2p_success, location });
    }
    return { updated_at: Math.floor(Date.now() / 1000), nodes };
  }
}

export default new PurityNodesApi();
