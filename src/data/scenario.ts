/**
 * SIGNAL — deterministic incident scenario.
 *
 * Everything here is seeded and reproducible. The same page load always produces
 * the same metrics, the same logs, the same root cause. This matters: a demo
 * video needs the incident to behave identically on take 4 as it did on take 1.
 */

export type ServiceId =
  | 'edge-gateway'
  | 'checkout-api'
  | 'pricing-svc'
  | 'catalog-db'
  | 'inventory-svc'
  | 'notify-worker';

export type Health = 'healthy' | 'degraded' | 'critical';

export interface Service {
  id: ServiceId;
  name: string;
  tier: 1 | 2 | 3;
  owner: string;
  dependsOn: ServiceId[];
  /** Baseline p99 latency in ms when everything is fine. */
  baseP99: number;
  /** Baseline error rate as a fraction. */
  baseErrorRate: number;
  /** How badly this service is affected by the incident, 0 = untouched. */
  blastFactor: number;
}

export const SERVICES: Service[] = [
  { id: 'edge-gateway',  name: 'edge-gateway',  tier: 1, owner: 'platform',  dependsOn: ['checkout-api', 'inventory-svc'], baseP99: 42,  baseErrorRate: 0.001, blastFactor: 0.35 },
  { id: 'checkout-api',  name: 'checkout-api',  tier: 1, owner: 'payments',  dependsOn: ['pricing-svc', 'inventory-svc'],   baseP99: 180, baseErrorRate: 0.002, blastFactor: 1.0  },
  { id: 'pricing-svc',   name: 'pricing-svc',   tier: 1, owner: 'payments',  dependsOn: ['catalog-db'],                     baseP99: 55,  baseErrorRate: 0.001, blastFactor: 0.9  },
  { id: 'catalog-db',    name: 'catalog-db',    tier: 1, owner: 'data',      dependsOn: [],                                 baseP99: 12,  baseErrorRate: 0.000, blastFactor: 0.8  },
  { id: 'inventory-svc', name: 'inventory-svc', tier: 2, owner: 'supply',    dependsOn: ['catalog-db'],                     baseP99: 90,  baseErrorRate: 0.003, blastFactor: 0.15 },
  { id: 'notify-worker', name: 'notify-worker', tier: 3, owner: 'growth',    dependsOn: [],                                 baseP99: 300, baseErrorRate: 0.01,  blastFactor: 0.0  },
];

export const REGIONS = ['us-east-1', 'eu-west-1', 'ap-south-1'] as const;
export type Region = (typeof REGIONS)[number];

/** eu-west-1 carries most of the pricing-svc traffic, so it hurts most. */
export const REGION_WEIGHT: Record<Region, number> = {
  'us-east-1': 0.45,
  'eu-west-1': 1.0,
  'ap-south-1': 0.2,
};

export interface Deploy {
  id: string;
  service: ServiceId;
  sha: string;
  author: string;
  /** Minutes before "now" that this shipped. */
  minutesAgo: number;
  summary: string;
  /** The actual culprit. */
  isRootCause?: boolean;
  diff?: string;
}

export const DEPLOYS: Deploy[] = [
  {
    id: 'dep_8821',
    service: 'pricing-svc',
    sha: 'a3f21c9',
    author: 'r.thapa',
    minutesAgo: 34,
    summary: 'perf: fetch tier discounts per line item',
    isRootCause: true,
    diff:
      'Replaced a single batched discount lookup with a per-line-item query.\n' +
      'For a 40-item cart this issues 40 sequential round trips to catalog-db\n' +
      'instead of 1, saturating the connection pool under peak load.',
  },
  { id: 'dep_8820', service: 'notify-worker', sha: '77bd004', author: 'm.shrestha', minutesAgo: 51, summary: 'chore: bump sdk to 4.2.1' },
  { id: 'dep_8819', service: 'edge-gateway',  sha: '1c0e5aa', author: 'platform-bot', minutesAgo: 190, summary: 'chore: rotate TLS certs' },
  { id: 'dep_8818', service: 'inventory-svc', sha: 'ff9012d', author: 'a.karki',    minutesAgo: 260, summary: 'feat: warehouse split shipping' },
];

export const FEATURE_FLAGS = [
  { key: 'pricing.per_item_discounts', enabled: true,  owner: 'payments', note: 'Gates the new discount path shipped in a3f21c9' },
  { key: 'checkout.express_lane',      enabled: true,  owner: 'payments', note: 'One-click checkout' },
  { key: 'catalog.read_replica',       enabled: false, owner: 'data',     note: 'Route reads to the replica pool' },
];

/** Incident began this many minutes before page load. */
export const INCIDENT_START_MIN_AGO = 31;

/** Simulated minutes elapsed per real second. Tuned so the 3-minute
 *  recovery ramp plays out in roughly 25 real seconds — long enough to
 *  read on camera, short enough not to dead-air a demo. */
export const SIM_MIN_PER_SEC = 0.12;

export const INCIDENT = {
  id: 'INC-2291',
  title: 'checkout-api p99 latency and error rate elevated',
  detectedBy: 'burn-rate alert · slo:checkout-availability',
  severity: 'SEV-2' as const,
  /** Human-readable ground truth, revealed only through investigation. */
  rootCause:
    'Deploy a3f21c9 to pricing-svc replaced a batched discount lookup with a ' +
    'per-line-item query, saturating the catalog-db connection pool. checkout-api ' +
    'requests queue behind it and time out. eu-west-1 is worst because it carries ' +
    'the largest share of pricing-svc traffic.',
};

/** Seeded PRNG so metrics are identical on every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
