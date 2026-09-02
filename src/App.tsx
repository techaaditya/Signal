import { useEffect, useState } from 'react';
import { ElicitationProvider } from './lib/elicitation';
import { IncidentTools } from './webmcp/tools';
import { useIncident, PHASE_META, PHASE_ORDER, PHASE_TOOLS, WRITE_TOOLS } from './store/incident';
import { hasWebMCP, useLiveTools, onToolCall, type LedgerEntry } from './lib/webmcp';
import { series, health, sparkline } from './lib/telemetry';
import { SERVICES, INCIDENT, SIM_MIN_PER_SEC } from './data/scenario';

export default function App() {
  return (
    <ElicitationProvider>
      <IncidentTools />
      <Shell />
    </ElicitationProvider>
  );
}

/** The one clock driving every chart: real seconds → simulated incident minutes. */
function useSimClock() {
  const tick = useIncident((s) => s.tick);
  useEffect(() => {
    const t = setInterval(() => tick(0.25 * SIM_MIN_PER_SEC), 250);
    return () => clearInterval(t);
  }, [tick]);
}

function Shell() {
  const s = useIncident();
  useSimClock();
  return (
    <div className="relative z-10 min-h-screen">
      <TopBar />
      {!hasWebMCP() && <NoAgentBanner />}
      <div className="grid gap-3 p-3 lg:grid-cols-[260px_1fr_320px]">
        <div className="space-y-3">
          <CapabilitySurface />
          <ServiceGrid />
        </div>
        <div className="space-y-3">
          <PhaseRail />
          <Metrics />
          <Timeline />
        </div>
        <div className="space-y-3">
          <Ledger />
          <StatusPage />
          {s.postmortem && <Postmortem />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ top bar */

function TopBar() {
  const { phase, escalatedBy, simMin } = useIncident();
  const meta = PHASE_META[phase];

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 rounded-full ring bg-current ${meta.accent}`} />
        <span className="mono text-[15px] tracking-tight">SIGNAL</span>
      </div>
      <div className="mono text-[12px] text-dim">
        <span className="text-red">{INCIDENT.severity}</span> · {INCIDENT.id} · {INCIDENT.title}
      </div>
      <div className="ml-auto flex items-center gap-5 mono text-[12px]">
        <span className="text-dim">open <span className="text-fg">{Math.floor(simMin)}m</span></span>
        <span className={meta.accent}>{meta.label}</span>
        {escalatedBy && <span className="text-dim">auth: {escalatedBy}</span>}
      </div>
    </header>
  );
}

function NoAgentBanner() {
  return (
    <div className="border-b border-amber/40 bg-amber/10 px-4 py-2 text-[12.5px] text-amber">
      Agent features are unavailable in this browser. Enable{' '}
      <code className="mono">chrome://flags/#enable-webmcp-testing</code> and relaunch Chrome,
      or open this page in ChatGPT's in-app browser. The console below still works read-only.
    </div>
  );
}

/* ------------------------------------------------- capability surface (⭐) */

function CapabilitySurface() {
  const live = useLiveTools();
  const { phase } = useIncident();
  const names = new Set(live.map((t) => t.name));

  // Everything the agent could ever have, so we can render the locked ones too.
  const all = [...new Set(Object.values(PHASE_TOOLS).flat())];

  return (
    <section className="panel">
      <div className="panel-head">
        <span>Agent capability surface</span>
        <span className="text-fg">{live.length}</span>
      </div>
      <div className="p-2">
        {all.map((name) => {
          const on = names.has(name);
          const danger = WRITE_TOOLS.has(name);
          return (
            <div key={name}
              className={`mono flex items-center gap-2 py-[3px] text-[11.5px] transition-colors ${
                on ? (danger ? 'text-red' : 'text-acc') : 'text-faint line-through decoration-faint/60'
              }`}>
              <span className="w-3 text-center">{on ? '●' : '○'}</span>
              <span className="truncate">{name}</span>
            </div>
          );
        })}
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-dim">
        {phase === 'triage'
          ? 'Struck-through tools are not registered. They are absent from the agent\u2019s tool list, not merely discouraged.'
          : phase === 'mitigate'
            ? 'Write capabilities are registered because a named human authorised it.'
            : 'Write capabilities have been withdrawn.'}
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- services */

function ServiceGrid() {
  const { mitigations, simMin, mitigatedAtSimMin } = useIncident();
  return (
    <section className="panel">
      <div className="panel-head"><span>Services</span></div>
      <div className="p-2">
        {SERVICES.map((svc) => {
          const h = health(svc.id, mitigations, simMin, mitigatedAtSimMin);
          const c = h === 'critical' ? 'text-red' : h === 'degraded' ? 'text-amber' : 'text-acc';
          const er = series(svc.id, 'error_rate', 'all', 12, mitigations, simMin, mitigatedAtSimMin);
          return (
            <div key={svc.id} className="flex items-center gap-2 py-1">
              <span className={`h-1.5 w-1.5 shrink-0 ${c} bg-current`} />
              {/* min-w-0 lets this truncate instead of being crushed by the
                  sparkline, which has no overflow-hidden and would otherwise
                  claim the flex row's automatic min-width for itself. */}
              <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg">{svc.name}</span>
              <span className={`mono shrink-0 text-[11px] ${c}`}>{sparkline(er.points)}</span>
              <span className="mono ml-auto shrink-0 text-[11px] text-dim">
                {(er.points.at(-1)!.v * 100).toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- phase rail */

function PhaseRail() {
  const { phase } = useIncident();
  const idx = PHASE_ORDER.indexOf(phase);
  return (
    <section className="panel flex items-stretch">
      {PHASE_ORDER.map((p, i) => {
        const active = i === idx, done = i < idx;
        return (
          <div key={p}
            className={`flex-1 border-r border-line px-3 py-2.5 last:border-r-0 ${
              active ? 'bg-raised' : ''}`}>
            <div className={`mono text-[11px] tracking-[0.14em] ${
              active ? PHASE_META[p].accent : done ? 'text-dim' : 'text-faint'}`}>
              {done ? '✓ ' : ''}{PHASE_META[p].label}
            </div>
            <div className={`mt-0.5 text-[11px] leading-tight ${active ? 'text-dim' : 'text-faint'}`}>
              {PHASE_META[p].blurb}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ----------------------------------------------------------------- metrics */

function Metrics() {
  const { mitigations, simMin, mitigatedAtSimMin } = useIncident();
  const p99 = series('checkout-api', 'p99_latency_ms', 'all', 45, mitigations, simMin, mitigatedAtSimMin);
  const pool = series('catalog-db', 'db_pool_saturation', 'all', 45, mitigations, simMin, mitigatedAtSimMin);

  return (
    <section className="panel">
      <div className="panel-head"><span>checkout-api · p99 latency</span>
        <span className="text-fg">{p99.points.at(-1)!.v.toFixed(0)}ms</span></div>
      <Chart points={p99.points} color="var(--color-red)" />
      <div className="panel-head border-t"><span>catalog-db · pool saturation</span>
        <span className="text-fg">{(pool.points.at(-1)!.v * 100).toFixed(0)}%</span></div>
      <Chart points={pool.points} color="var(--color-amber)" />
    </section>
  );
}

function Chart({ points, color }: { points: { t: number; v: number }[]; color: string }) {
  const vs = points.map((p) => p.v);
  const max = Math.max(...vs) * 1.1, min = 0;
  const W = 100, H = 100;
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - ((p.v - min) / (max - min || 1)) * H;
    return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full">
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--color-line)" strokeWidth="0.3" />
      ))}
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={color} opacity="0.10" />
      <path d={d} fill="none" stroke={color} strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------------------------------------------------------------- timeline */

const ACTOR_STYLE = {
  agent:  { c: 'text-agent',  label: 'AGENT' },
  human:  { c: 'text-acc',    label: 'HUMAN' },
  system: { c: 'text-dim',    label: 'SYS'   },
} as const;

function Timeline() {
  const { timeline } = useIncident();
  const t0 = timeline[0].at;
  return (
    <section className="panel">
      <div className="panel-head"><span>Shared incident timeline</span>
        <span className="text-fg">{timeline.length}</span></div>
      <div className="max-h-[320px] space-y-px overflow-y-auto p-2">
        {timeline.map((e) => {
          const a = ACTOR_STYLE[e.actor];
          return (
            <div key={e.id} className="surface-in flex gap-2 px-1 py-[3px] hover:bg-raised">
              <span className="mono w-11 shrink-0 text-[10.5px] text-faint">
                T+{Math.round((e.at - t0) / 60000)}m
              </span>
              <span className={`mono w-11 shrink-0 text-[10.5px] ${a.c}`}>{a.label}</span>
              <div className="min-w-0">
                <div className="text-[12.5px] leading-snug text-fg">{e.text}</div>
                {e.evidence?.length ? (
                  <div className="mono mt-0.5 text-[10.5px] text-faint">{e.evidence.join(' · ')}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ ledger */

function Ledger() {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  useEffect(() => onToolCall((e) => setRows((r) => [e, ...r].slice(0, 60))), []);
  return (
    <section className="panel">
      <div className="panel-head"><span>Tool call ledger</span><span className="text-fg">{rows.length}</span></div>
      <div className="max-h-[300px] overflow-y-auto p-2">
        {rows.length === 0 && <p className="px-1 py-3 text-[12px] text-faint">No calls yet.</p>}
        {rows.map((r) => (
          <div key={r.id} className="surface-in border-b border-line/60 py-1.5 last:border-0">
            <div className="mono flex items-center gap-2 text-[11.5px]">
              <span className={r.ok ? 'text-agent' : 'text-red'}>{r.tool}</span>
              {r.humanInLoop && <span className="text-acc" title="paused for a human">⏸ human</span>}
              <span className="ml-auto text-faint">{r.ms}ms</span>
            </div>
            <div className="mono mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-dim">{r.result}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- status page */

function StatusPage() {
  const { statusPagePosts } = useIncident();
  if (!statusPagePosts.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><span>Public status page</span></div>
      <div className="space-y-2 p-3">
        {statusPagePosts.map((p, i) => (
          <div key={i} className="border-l-2 border-blue pl-3">
            <div className="mono mb-1 text-[10.5px] text-faint">
              {new Date(p.at).toLocaleTimeString()} · drafted by agent
              {p.editedByHuman && <span className="text-acc"> · edited by operator</span>}
            </div>
            <p className="text-[12.5px] leading-relaxed text-fg">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Postmortem() {
  const { postmortem } = useIncident();
  return (
    <section className="panel">
      <div className="panel-head"><span>Postmortem</span></div>
      <pre className="mono max-h-[400px] overflow-y-auto whitespace-pre-wrap p-3 text-[11.5px] leading-relaxed text-fg">
        {postmortem}
      </pre>
    </section>
  );
}
