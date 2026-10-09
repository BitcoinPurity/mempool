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
