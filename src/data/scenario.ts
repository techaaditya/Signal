/**
 * SIGNAL — deterministic incident scenarios.
 *
 * Everything here is seeded and reproducible. The same page load always produces
 * the same metrics, the same logs, the same root cause. This matters: a demo
 * video needs the incident to behave identically on take 4 as it did on take 1.
 *
 * Two incidents ship: a gradual latency cascade (`latency`) and a sudden
 * total-outage TLS certificate expiry (`cert`). They share service topology
 * and the tool catalog, but have different root causes, different metric
 * shapes, and different correct mitigations — so the `cert` incident cannot
 * be solved by replaying the `latency` script.
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
  /** How badly this service's latency/error metrics are affected, 0 = untouched. */
  blastFactor: number;
  /** How badly this service's *traffic volume* is affected. Defaults to blastFactor.
   *  A service can be internally healthy (low blastFactor) while starved of
   *  traffic upstream (high rpsBlastFactor) — that split is the whole point
   *  of the cert-expiry scenario. */
  rpsBlastFactor?: number;
}

const TOPOLOGY: Omit<Service, 'blastFactor' | 'rpsBlastFactor'>[] = [
  { id: 'edge-gateway',  name: 'edge-gateway',  tier: 1, owner: 'platform', dependsOn: ['checkout-api', 'inventory-svc'], baseP99: 42,  baseErrorRate: 0.001 },
  { id: 'checkout-api',  name: 'checkout-api',  tier: 1, owner: 'payments', dependsOn: ['pricing-svc', 'inventory-svc'],   baseP99: 180, baseErrorRate: 0.002 },
  { id: 'pricing-svc',   name: 'pricing-svc',   tier: 1, owner: 'payments', dependsOn: ['catalog-db'],                     baseP99: 55,  baseErrorRate: 0.001 },
  { id: 'catalog-db',    name: 'catalog-db',    tier: 1, owner: 'data',     dependsOn: [],                                 baseP99: 12,  baseErrorRate: 0.000 },
  { id: 'inventory-svc', name: 'inventory-svc', tier: 2, owner: 'supply',   dependsOn: ['catalog-db'],                     baseP99: 90,  baseErrorRate: 0.003 },
  { id: 'notify-worker', name: 'notify-worker', tier: 3, owner: 'growth',   dependsOn: [],                                 baseP99: 300, baseErrorRate: 0.01  },
];

function servicesWithBlast(blast: Record<ServiceId, number>, rpsBlast?: Partial<Record<ServiceId, number>>): Service[] {
  return TOPOLOGY.map((t) => ({ ...t, blastFactor: blast[t.id], rpsBlastFactor: rpsBlast?.[t.id] }));
}

/** Service ids are identical across every scenario — only their blast
 *  factors differ — so tool schemas can reference this directly rather
 *  than depending on whichever profile happens to be active. */
export const SERVICE_IDS: ServiceId[] = TOPOLOGY.map((t) => t.id);

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

export const FEATURE_FLAGS = [
  { key: 'pricing.per_item_discounts', enabled: true,  owner: 'payments', note: 'Gates the new discount path shipped in a3f21c9' },
  { key: 'checkout.express_lane',      enabled: true,  owner: 'payments', note: 'One-click checkout' },
  { key: 'catalog.read_replica',       enabled: false, owner: 'data',     note: 'Route reads to the replica pool' },
] as const;

export const DEFAULT_FLAGS: Record<string, boolean> = {
  'pricing.per_item_discounts': true, 'checkout.express_lane': true, 'catalog.read_replica': false,
};
export const DEFAULT_REPLICAS: Record<ServiceId, number> = {
  'edge-gateway': 8, 'checkout-api': 12, 'pricing-svc': 6, 'catalog-db': 3, 'inventory-svc': 4, 'notify-worker': 2,
};

/** Simulated minutes elapsed per real second. Tuned so a 3-minute recovery
 *  ramp plays out in roughly 25 real seconds — long enough to read on
 *  camera, short enough not to dead-air a demo. Shared by every scenario. */
export const SIM_MIN_PER_SEC = 0.12;

export type Mitigation =
  | { kind: 'rollback'; service: ServiceId }
  | { kind: 'flag'; key: string; enabled: boolean }
  | { kind: 'scale'; service: ServiceId; replicas: number }
  | { kind: 'drain'; region: Region }
  | { kind: 'renew_cert'; service: ServiceId };

export interface IncidentMeta {
  id: string;
  title: string;
  detectedBy: string;
  severity: 'SEV-1' | 'SEV-2';
  /** Human-readable ground truth, revealed only through investigation. */
  rootCause: string;
}

export interface IncidentProfile {
  id: 'latency' | 'cert';
  /** Short label for the scenario switcher. */
  label: string;
  incident: IncidentMeta;
  services: Service[];
  deploys: Deploy[];
  /** simMin at page load — how far into the incident we start. */
  startMinAgo: number;
  /** Minutes for severity to ramp from 0 to fully critical. Small = sudden onset. */
  severityRampMin: number;
  /** Minutes for a correct mitigation's relief to fully take hold. */
  recoveryRampMin: number;
  /** Multiplier on rps impact — how hard traffic volume can crater. 0.3 is a
   *  soft dip (users retrying through a slow path); higher values model
   *  traffic that never arrives at all (e.g. blocked upstream at the edge). */
  rpsDropMax: number;
  logTemplates: Record<ServiceId, (n: number) => string>;
  /** 0..1 — how much a given set of mitigations resolves *this* incident.
   *  The wrong tool for the wrong incident should barely move this. */
  relief: (mitigations: Mitigation[]) => number;
}

/* ===================================================================
   Scenario 1 — checkout latency cascade (the original incident)
   =================================================================== */

const latencyServices = servicesWithBlast({
  'edge-gateway': 0.35, 'checkout-api': 1.0, 'pricing-svc': 0.9,
  'catalog-db': 0.8, 'inventory-svc': 0.15, 'notify-worker': 0.0,
});

const latencyDeploys: Deploy[] = [
  {
    id: 'dep_8821', service: 'pricing-svc', sha: 'a3f21c9', author: 'r.thapa', minutesAgo: 34,
    summary: 'perf: fetch tier discounts per line item', isRootCause: true,
    diff:
      'Replaced a single batched discount lookup with a per-line-item query.\n' +
      'For a 40-item cart this issues 40 sequential round trips to catalog-db\n' +
      'instead of 1, saturating the connection pool under peak load.',
  },
  { id: 'dep_8820', service: 'notify-worker', sha: '77bd004', author: 'm.shrestha', minutesAgo: 51, summary: 'chore: bump sdk to 4.2.1' },
  { id: 'dep_8819', service: 'edge-gateway',  sha: '1c0e5aa', author: 'platform-bot', minutesAgo: 190, summary: 'chore: rotate TLS certs' },
  { id: 'dep_8818', service: 'inventory-svc', sha: 'ff9012d', author: 'a.karki',    minutesAgo: 260, summary: 'feat: warehouse split shipping' },
];

function reliefLatency(mitigations: Mitigation[]): number {
  let r = 0;
  for (const x of mitigations) {
    if (x.kind === 'rollback' && x.service === 'pricing-svc') r += 0.95;
    else if (x.kind === 'flag' && x.key === 'pricing.per_item_discounts' && !x.enabled) r += 0.85;
    else if (x.kind === 'scale' && x.service === 'catalog-db') r += 0.25;
    else if (x.kind === 'drain') r += 0.15;
    else r += 0.02;
  }
  return Math.min(r, 1);
}

const LATENCY_LOG_TEMPLATES: Record<ServiceId, (n: number) => string> = {
  'checkout-api': (n) => `upstream timeout calling pricing-svc after 3000ms (attempt ${1 + (n % 3)})`,
  'pricing-svc': (n) => `catalog-db acquire timed out; pool 40/40 in use, ${8 + (n % 14)} waiters queued`,
  'catalog-db': (n) => `slow query 1842ms SELECT tier_discount WHERE sku=$1 (conn ${100 + (n % 40)})`,
  'edge-gateway': () => `502 from checkout-api, circuit half-open`,
  'inventory-svc': () => `retrying catalog-db read, backoff 250ms`,
  'notify-worker': () => `dispatched 214 emails ok`,
};

const LATENCY_PROFILE: IncidentProfile = {
  id: 'latency',
  label: 'Checkout latency',
  incident: {
    id: 'INC-2291',
    title: 'checkout-api p99 latency and error rate elevated',
    detectedBy: 'burn-rate alert · slo:checkout-availability',
    severity: 'SEV-2',
    rootCause:
      'Deploy a3f21c9 to pricing-svc replaced a batched discount lookup with a ' +
      'per-line-item query, saturating the catalog-db connection pool. checkout-api ' +
      'requests queue behind it and time out. eu-west-1 is worst because it carries ' +
      'the largest share of pricing-svc traffic.',
  },
  services: latencyServices,
  deploys: latencyDeploys,
  startMinAgo: 31,
  severityRampMin: 8,
  recoveryRampMin: 3,
  rpsDropMax: 0.3,
  logTemplates: LATENCY_LOG_TEMPLATES,
  relief: reliefLatency,
};

/* ===================================================================
   Scenario 2 — edge-gateway TLS certificate expiry (total outage)
   =================================================================== */

/** Cert-scenario blast: edge-gateway's own error rate is near-total (the
 *  handshake itself fails). Everything behind it is internally *healthy* —
 *  low error/latency blastFactor — but starved of traffic, modeled via
 *  rpsBlastFactor. A health check that only reads error_rate will misread
 *  the whole backend as fine; only rps or the topology view reveals why. */
const certServices = servicesWithBlast(
  {
    'edge-gateway': 1.0, 'checkout-api': 0.03, 'pricing-svc': 0.02,
    'catalog-db': 0.01, 'inventory-svc': 0.02, 'notify-worker': 0.0,
  },
  {
    'edge-gateway': 0.12, 'checkout-api': 0.95, 'pricing-svc': 0.9,
    'catalog-db': 0.4, 'inventory-svc': 0.9, 'notify-worker': 0.0,
  },
);

const certDeploys: Deploy[] = [
  {
    id: 'dep_9010', service: 'notify-worker', sha: 'e41aa02', author: 'm.shrestha', minutesAgo: 14,
    summary: 'chore: bump sdk to 4.3.0',
  },
  {
    id: 'dep_8819', service: 'edge-gateway', sha: '1c0e5aa', author: 'platform-bot', minutesAgo: 202,
    summary: 'chore: rotate TLS certs', isRootCause: true,
    diff:
      'Automated cert rotation job. A unit-mismatch bug set the new certificate’s\n' +
      'validity window with cert.NotAfter = issuedAt + 196*time.Minute — it should\n' +
      'have been 196*24*time.Hour. The cert was valid for 196 minutes after this\n' +
      'deploy, then quietly expired. Every TLS handshake at the edge has failed since.',
  },
  {
    id: 'dep_8818', service: 'inventory-svc', sha: 'ff9012d', author: 'a.karki', minutesAgo: 340,
    summary: 'feat: warehouse split shipping',
  },
];

function reliefCert(mitigations: Mitigation[]): number {
  let r = 0;
  for (const x of mitigations) {
    if (x.kind === 'renew_cert' && x.service === 'edge-gateway') r += 0.97;
    else r += 0.02; // the latency-incident playbook barely moves a cert outage
  }
  return Math.min(r, 1);
}

const CERT_LOG_TEMPLATES: Record<ServiceId, (n: number) => string> = {
  'edge-gateway': (n) => `TLS handshake failed: x509: certificate has expired (attempt ${1 + (n % 3)})`,
  'checkout-api': () => `0 inbound requests in the last 30s`,
  'pricing-svc': () => `0 inbound requests in the last 30s`,
  'catalog-db': () => `connection pool 2/40 in use — nominal`,
  'inventory-svc': () => `0 inbound requests in the last 30s`,
  'notify-worker': (n) => `dispatched ${180 + (n % 40)} emails ok`,
};

const CERT_PROFILE: IncidentProfile = {
  id: 'cert',
  label: 'TLS cert expiry',
  incident: {
    id: 'INC-2308',
    title: 'edge-gateway TLS handshake failures — total outage',
    detectedBy: 'synthetic TLS probe · edge-gateway:443',
    severity: 'SEV-1',
    rootCause:
      'Deploy 1c0e5aa rotated edge-gateway’s TLS certificate with a unit-mismatch bug ' +
      'that set its validity to 196 minutes instead of 196 days. The certificate expired ' +
      '6 minutes ago; every client TLS handshake now fails at the edge before a request ' +
      'reaches any backend service — which is why everything behind it looks quiet ' +
      'rather than unhealthy.',
  },
  services: certServices,
  deploys: certDeploys,
  startMinAgo: 6,
  severityRampMin: 0.5,
  recoveryRampMin: 1,
  rpsDropMax: 1.4,
  logTemplates: CERT_LOG_TEMPLATES,
  relief: reliefCert,
};

export type ScenarioId = IncidentProfile['id'];

export const SCENARIOS: Record<ScenarioId, IncidentProfile> = {
  latency: LATENCY_PROFILE,
  cert: CERT_PROFILE,
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
