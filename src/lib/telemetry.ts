/**
 * Telemetry engine. Generates metrics and logs deterministically from the
 * active incident profile, and reacts to mitigations the agent applies.
 *
 * The key idea: `mitigations` is a set of actions already taken. Metrics are a
 * pure function of (profile, service, region, minutesAgo, mitigations). Apply
 * the correct fix for *this* incident and the curve recovers — because the
 * generator says so, not because we faked a second dataset. Apply the wrong
 * incident's playbook and it barely moves, because `profile.relief` says so too.
 */

import {
  REGION_WEIGHT, mulberry32,
  type ServiceId, type Region, type Health, type Mitigation, type IncidentProfile,
} from '../data/scenario';

export type { Mitigation };

export interface Point { t: number; v: number }

export interface MetricSeries {
  service: ServiceId;
  region: Region | 'all';
  metric: 'p99_latency_ms' | 'error_rate' | 'rps' | 'db_pool_saturation';
  points: Point[];
  unit: string;
}

/**
 * @param windowMin  how far back to generate, in simulated minutes
 * @param nowMin  current simulated-minutes-since-incident-open (the sim clock)
 * @param mitigatedAtMin  simMin value when mitigation was applied (null = not yet)
 */
export function series(
  profile: IncidentProfile,
  service: ServiceId,
  metric: MetricSeries['metric'],
  region: Region | 'all',
  windowMin = 45,
  mitigations: Mitigation[] = [],
  nowMin: number,
  mitigatedAtMin: number | null = null,
): MetricSeries {
  const svc = profile.services.find((s) => s.id === service)!;
  const rnd = mulberry32(hash(service + metric + region));
  const regionMul = region === 'all' ? 0.6 : REGION_WEIGHT[region];
  const r = profile.relief(mitigations);

  const points: Point[] = [];
  for (let ago = windowMin; ago >= 0; ago--) {
    // Absolute simulated time of this sample, in minutes since incident open.
    const at = nowMin - ago;
    let sev = 0;
    if (at > 0) sev = Math.min(1, at / profile.severityRampMin);

    // Apply relief only after the mitigation landed, with a ramp.
    if (mitigatedAtMin !== null && at > mitigatedAtMin) {
      const since = at - mitigatedAtMin;
      sev *= 1 - r * Math.min(1, since / profile.recoveryRampMin);
    }

    const rpsBlast = svc.rpsBlastFactor ?? svc.blastFactor;
    const impact = sev * svc.blastFactor * regionMul;
    const impactRps = sev * rpsBlast * regionMul;
    const jitter = 0.9 + rnd() * 0.2;
    let v: number;

    switch (metric) {
      case 'p99_latency_ms':
        v = svc.baseP99 * (1 + impact * 11) * jitter;
        break;
      case 'error_rate':
        v = (svc.baseErrorRate + impact * 0.14) * jitter;
        break;
      case 'rps':
        // Traffic dips as users abandon, or craters if it never reaches this service at all.
        v = 1200 * (region === 'all' ? 1 : REGION_WEIGHT[region])
          * Math.max(0.05, 1 - impactRps * profile.rpsDropMax) * jitter;
        break;
      case 'db_pool_saturation':
        v = Math.min(1, (0.22 + impact * 0.9) * jitter);
        break;
    }
    points.push({ t: -ago, v: round(v, metric) });
  }

  return {
    service, region, metric, points,
    unit: metric === 'p99_latency_ms' ? 'ms' : metric === 'rps' ? 'req/s' : '%',
  };
}

function round(v: number, m: MetricSeries['metric']) {
  return m === 'error_rate' || m === 'db_pool_saturation'
    ? Math.round(v * 10000) / 10000
    : Math.round(v * 10) / 10;
}

export function health(
  profile: IncidentProfile,
  service: ServiceId,
  mitigations: Mitigation[],
  nowMin: number,
  mitigatedAtMin: number | null,
): Health {
  const s = series(profile, service, 'error_rate', 'all', 2, mitigations, nowMin, mitigatedAtMin);
  const now = s.points.at(-1)!.v;
  if (now > 0.05) return 'critical';
  if (now > 0.012) return 'degraded';
  return 'healthy';
}

export interface LogLine {
  t: number; // minutes ago (negative)
  service: ServiceId;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function logs(
  profile: IncidentProfile,
  service: ServiceId | 'all',
  query: string,
  limit = 25,
  mitigations: Mitigation[] = [],
  nowMin: number,
  mitigatedAtMin: number | null = null,
): LogLine[] {
  const targets = service === 'all' ? profile.services.map((s) => s.id) : [service];
  const out: LogLine[] = [];
  const rnd = mulberry32(hash(String(service) + query));

  for (const id of targets) {
    const svc = profile.services.find((s) => s.id === id)!;
    for (let ago = Math.max(nowMin, profile.startMinAgo); ago >= 0; ago -= 2) {
      const at = nowMin - ago;
      const mitigated = mitigatedAtMin !== null && at > mitigatedAtMin;
      const noisy = svc.blastFactor > 0.5 && !mitigated && at > 0;
      const n = Math.floor(rnd() * 100);
      out.push({
        t: -ago,
        service: id,
        level: noisy ? (rnd() > 0.4 ? 'error' : 'warn') : 'info',
        message: noisy
          ? profile.logTemplates[id](n)
          : `${id} healthy · p99 nominal`,
      });
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? out.filter((l) => l.message.toLowerCase().includes(q) || l.level === q)
    : out;

  return filtered.sort((a, b) => b.t - a.t).slice(0, limit);
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Compact ASCII sparkline — this is what the agent reads. Cheap and legible. */
export function sparkline(points: Point[]): string {
  const blocks = '▁▂▃▄▅▆▇█';
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  return vs.map((v) => blocks[Math.min(7, Math.floor(((v - min) / span) * 7.99))]).join('');
}
