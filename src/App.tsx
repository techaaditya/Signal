import { useEffect, useState } from 'react';
import { ElicitationProvider } from './lib/elicitation';
import { IncidentTools } from './webmcp/tools';
import { useIncident, PHASE_META, PHASE_ORDER, PHASE_TOOLS, WRITE_TOOLS } from './store/incident';
import { hasWebMCP, useLiveTools, onToolCall, type LedgerEntry } from './lib/webmcp';
import { series, health, sparkline } from './lib/telemetry';
import { SCENARIOS, SIM_MIN_PER_SEC, type ScenarioId } from './data/scenario';

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
      {s.compareMode && <ComparisonStrip />}
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
          <DenialLog />
          <StatusPage />
          {s.postmortem && <Postmortem />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ top bar */

function TopBar() {
  const { phase, escalatedBy, simMin, profile, denials, compareMode, setCompareMode } = useIncident();
  const meta = PHASE_META[phase];
  const blocked = denials.filter((d) => d.kind === 'declined').length;

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-panel px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 rounded-full ring bg-current ${meta.accent}`} />
        <span className="mono text-[15px] tracking-tight">SIGNAL</span>
      </div>
      <div className="mono text-[12px] text-dim">
        <span className="text-red">{profile.incident.severity}</span> · {profile.incident.id} · {profile.incident.title}
      </div>
      <ScenarioSwitcher />
      <div className="ml-auto flex items-center gap-5 mono text-[12px]">
        {blocked > 0 && <span className="text-dim">{blocked} blocked by phase policy</span>}
        <button
          onClick={() => setCompareMode(!compareMode)}
          className={`border px-2 py-1 text-[11px] transition-colors ${
            compareMode ? 'border-agent text-agent' : 'border-line text-faint hover:text-dim'
          }`}
        >
          compare: no WebMCP
        </button>
        <span className="text-dim">open <span className="text-fg">{Math.floor(simMin)}m</span></span>
        <span className={meta.accent}>{meta.label}</span>
        {escalatedBy && <span className="text-dim">auth: {escalatedBy}</span>}
      </div>
    </header>
  );
}

function ScenarioSwitcher() {
  const { scenarioId, switchScenario } = useIncident();
  return (
    <div className="mono flex items-center gap-1 text-[11px]">
      {(Object.keys(SCENARIOS) as ScenarioId[]).map((id) => (
        <button
          key={id}
          onClick={() => id !== scenarioId && switchScenario(id)}
          title={`Switch to the ${SCENARIOS[id].label} incident`}
          className={`border px-2 py-1 transition-colors ${
            id === scenarioId ? 'border-fg text-fg' : 'border-line text-faint hover:text-dim'
          }`}
        >
          {SCENARIOS[id].label}
        </button>
      ))}
    </div>
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

/* ------------------------------------------------------ WebMCP comparison */

function ComparisonStrip() {
  return (
    <div className="grid gap-3 border-b border-line bg-raised/30 p-3 md:grid-cols-2">
      <div className="panel">
        <div className="panel-head"><span>With WebMCP</span><span className="text-acc">live</span></div>
        <p className="border-b border-line px-3 py-2 text-[11px] leading-relaxed text-dim">
          The agent calls typed tools registered directly on this page. Capability is granted
          or withdrawn by (un)registering a tool — the model literally cannot see or call what
          the current phase hasn't registered.
        </p>
        <CapabilitySurface compact />
      </div>
      <div className="panel border-agent/40">
        <div className="panel-head"><span>Without WebMCP</span><span className="text-red">simulated</span></div>
        <p className="border-b border-line px-3 py-2 text-[11px] leading-relaxed text-dim">
          The agent has no tool surface. It must screen-scrape this page, infer intent from
          pixels and DOM text, and act through whatever generic "click" or "type" affordance
          its host provides — with no phase gate, no confirmation contract, and no structural
          reason it couldn't try to click a rollback button that doesn't exist yet.
        </p>
        <NoWebMCPSurface />
      </div>
    </div>
  );
}

function NoWebMCPSurface() {
  const all = [...new Set(Object.values(PHASE_TOOLS).flat())];
  return (
    <div className="p-2">
      {all.map((name) => (
        <div key={name} className="mono flex items-center gap-2 py-[3px] text-[11.5px] text-faint line-through decoration-faint/60">
          <span className="w-3 text-center">○</span>
          <span className="truncate">{name}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------- capability surface (⭐) */

function CapabilitySurface({ compact }: { compact?: boolean }) {
  const live = useLiveTools();
  const { phase } = useIncident();
  const names = new Set(live.map((t) => t.name));

  // Everything the agent could ever have, so we can render the locked ones too.
  const all = [...new Set(Object.values(PHASE_TOOLS).flat())];

  return (
    <section className={compact ? '' : 'panel'}>
      {!compact && (
        <div className="panel-head">
          <span>Agent capability surface</span>
          <span className="text-fg">{live.length}</span>
        </div>
      )}
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
      {!compact && (
        <p className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-dim">
          {phase === 'triage'
            ? 'Struck-through tools are not registered. They are absent from the agent’s tool list, not merely discouraged.'
            : phase === 'mitigate'
              ? 'Write capabilities are registered because a named human authorised it.'
              : 'Write capabilities have been withdrawn.'}
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- services */

function ServiceGrid() {
  const { mitigations, simMin, mitigatedAtSimMin, profile } = useIncident();
  return (
    <section className="panel">
      <div className="panel-head"><span>Services</span></div>
      <div className="p-2">
        {profile.services.map((svc) => {
          const h = health(profile, svc.id, mitigations, simMin, mitigatedAtSimMin);
          const c = h === 'critical' ? 'text-red' : h === 'degraded' ? 'text-amber' : 'text-acc';
          const er = series(profile, svc.id, 'error_rate', 'all', 12, mitigations, simMin, mitigatedAtSimMin);
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

interface FeaturedMetric {
  service: Parameters<typeof series>[1];
  metric: Parameters<typeof series>[2];
  label: string;
  color: string;
  fmt: (v: number) => string;
}

function Metrics() {
  const { mitigations, simMin, mitigatedAtSimMin, profile } = useIncident();

  // Which two charts tell this incident's story best. A p99/pool-saturation
  // pair says nothing useful during a total-outage TLS failure; an
  // error-rate/traffic pair says nothing useful during a gradual DB cascade.
  const featured: FeaturedMetric[] = profile.id === 'cert'
    ? [
        { service: 'edge-gateway', metric: 'error_rate', label: 'edge-gateway · handshake error rate', color: 'var(--color-red)', fmt: (v) => `${(v * 100).toFixed(1)}%` },
        { service: 'checkout-api', metric: 'rps', label: 'checkout-api · inbound traffic', color: 'var(--color-amber)', fmt: (v) => `${v.toFixed(0)}/s` },
      ]
    : [
        { service: 'checkout-api', metric: 'p99_latency_ms', label: 'checkout-api · p99 latency', color: 'var(--color-red)', fmt: (v) => `${v.toFixed(0)}ms` },
        { service: 'catalog-db', metric: 'db_pool_saturation', label: 'catalog-db · pool saturation', color: 'var(--color-amber)', fmt: (v) => `${(v * 100).toFixed(0)}%` },
      ];

  return (
    <section className="panel">
      {featured.map((f, i) => {
        const ser = series(profile, f.service, f.metric, 'all', 45, mitigations, simMin, mitigatedAtSimMin);
        return (
          <div key={`${f.service}-${f.metric}`}>
            <div className={`panel-head ${i > 0 ? 'border-t' : ''}`}>
              <span>{f.label}</span>
              <span className="text-fg">{f.fmt(ser.points.at(-1)!.v)}</span>
            </div>
            <Chart points={ser.points} color={f.color} />
          </div>
        );
      })}
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

/* ------------------------------------------------------------- denial log */

const DENIAL_STYLE: Record<string, { c: string; label: string }> = {
  declined: { c: 'text-red', label: 'DENIED' },
  escalation_requested: { c: 'text-amber', label: 'ASKED' },
  phase_transition: { c: 'text-blue', label: 'PHASE' },
};

function DenialLog() {
  const { denials } = useIncident();
  if (!denials.length) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Capability boundary</span>
        <span className="text-fg">{denials.length}</span>
      </div>
      <div className="max-h-[220px] overflow-y-auto p-2">
        {[...denials].reverse().map((d) => {
          const style = DENIAL_STYLE[d.kind];
          return (
            <div key={d.id} className="surface-in flex gap-2 px-1 py-[3px] text-[11px]">
              <span className="mono w-10 shrink-0 text-faint">T+{Math.round(d.atSimMin)}m</span>
              <span className={`mono w-14 shrink-0 ${style.c}`}>{style.label}</span>
              <span className="min-w-0 flex-1 truncate text-dim" title={d.text}>{d.text}</span>
            </div>
          );
        })}
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
  if (!postmortem) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Postmortem</span>
        <span className="flex items-center gap-3 text-[10px] normal-case tracking-normal text-dim">
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 bg-agent" />agent</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 bg-acc" />operator</span>
        </span>
      </div>
      <div className="mono max-h-[400px] overflow-y-auto p-3 text-[11.5px] leading-relaxed">
        {postmortem.lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <span
              className={`mt-[5px] h-1.5 w-1.5 shrink-0 ${l.author === 'agent' ? 'bg-agent' : 'bg-acc'}`}
              title={l.author === 'agent' ? 'from the agent’s draft' : 'added or edited by the operator'}
            />
            <span className="whitespace-pre-wrap text-fg">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
