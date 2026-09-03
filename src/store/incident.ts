/**
 * Incident state. Single source of truth for both the human UI and the agent's
 * tool surface — they are literally reading the same object.
 */

import { create } from 'zustand';
import type { Mitigation } from '../data/scenario';
import { SCENARIOS, DEFAULT_FLAGS, DEFAULT_REPLICAS, type ScenarioId, type IncidentProfile } from '../data/scenario';

export type Phase = 'triage' | 'mitigate' | 'recover' | 'review';

export const PHASE_ORDER: Phase[] = ['triage', 'mitigate', 'recover', 'review'];

export const PHASE_META: Record<Phase, { label: string; blurb: string; accent: string }> = {
  triage:   { label: 'TRIAGE',   blurb: 'Read-only. Understand before you touch.', accent: 'text-amber' },
  mitigate: { label: 'MITIGATE', blurb: 'Write access unlocked by a human.',       accent: 'text-red' },
  recover:  { label: 'RECOVER',  blurb: 'Verifying. Write access withdrawn.',      accent: 'text-acc' },
  review:   { label: 'REVIEW',   blurb: 'Closed. Authoring the postmortem.',       accent: 'text-blue' },
};

/**
 * Single source of truth for which tool names are registered in which phase.
 * `webmcp/tools.tsx` derives each tool's `enabled` predicate from this map,
 * and the capability panel derives its display list from it too — so the two
 * can never drift the way the old hand-maintained App.tsx copy did.
 */
const ALWAYS_ON = [
  'get_incident_overview', 'query_metrics', 'search_logs', 'list_recent_deploys',
  'inspect_deploy', 'get_service_topology', 'record_hypothesis', 'ask_operator',
];

export const PHASE_TOOLS: Record<Phase, string[]> = {
  triage: [...ALWAYS_ON, 'request_escalation'],
  mitigate: [
    ...ALWAYS_ON,
    'rollback_deploy', 'toggle_feature_flag', 'scale_service', 'drain_region', 'renew_certificate',
    'page_oncall', 'publish_status_update', 'declare_mitigated',
  ],
  recover: [...ALWAYS_ON, 'verify_recovery', 'resolve_incident', 'get_incident_timeline'],
  review: [...ALWAYS_ON, 'get_incident_timeline', 'draft_postmortem'],
};

/** Tools that write to production — rendered in red in the capability panel. */
export const WRITE_TOOLS = new Set(PHASE_TOOLS.mitigate.filter(
  (t) => !ALWAYS_ON.includes(t),
));

export type Actor = 'human' | 'agent' | 'system';

export interface TimelineEntry {
  id: string;
  at: number;
  actor: Actor;
  kind: 'observation' | 'hypothesis' | 'action' | 'decision' | 'phase' | 'comms';
  text: string;
  /** Attached evidence — metric names, log excerpts, deploy shas. */
  evidence?: string[];
}

/** A capability-boundary event: something the phase policy stopped, or the
 *  operator declined, or a phase transition that changed what's possible.
 *  Kept separate from the timeline so the top bar can show a pure count of
 *  "things the policy or the operator said no to" without conflating it
 *  with ordinary investigation activity. */
export interface DenialEntry {
  id: string;
  atSimMin: number;
  kind: 'escalation_requested' | 'declined' | 'phase_transition';
  text: string;
}

export interface PostmortemLine {
  text: string;
  author: 'agent' | 'human';
}

export interface Postmortem {
  lines: PostmortemLine[];
}

interface State {
  scenarioId: ScenarioId;
  profile: IncidentProfile;
  phase: Phase;
  /** Which named human authorised the phase escalation. Null until they do. */
  escalatedBy: string | null;
  /** Simulated minutes elapsed since the incident opened. Drives every chart. */
  simMin: number;
  mitigations: Mitigation[];
  /** simMin at the moment the first mitigation landed. Null until one does. */
  mitigatedAtSimMin: number | null;
  timeline: TimelineEntry[];
  denials: DenialEntry[];
  statusPagePosts: { at: number; body: string; authoredBy: Actor; editedByHuman: boolean }[];
  postmortem: Postmortem | null;
  flags: Record<string, boolean>;
  replicas: Record<string, number>;
  drainedRegions: string[];
  pagedTeams: string[];
  compareMode: boolean;

  setPhase: (p: Phase, by: string | null) => void;
  addEntry: (e: Omit<TimelineEntry, 'id' | 'at'>) => TimelineEntry;
  recordDenial: (kind: DenialEntry['kind'], text: string) => void;
  applyMitigation: (m: Mitigation) => void;
  postStatus: (body: string, authoredBy: Actor, editedByHuman: boolean) => void;
  setPostmortem: (draft: string, final: string) => void;
  tick: (dtMin: number) => void;
  switchScenario: (id: ScenarioId) => void;
  setCompareMode: (on: boolean) => void;
  reset: () => void;
}

function seedFor(profile: IncidentProfile) {
  return {
    scenarioId: profile.id,
    profile,
    phase: 'triage' as Phase,
    escalatedBy: null,
    simMin: profile.startMinAgo,
    mitigations: [] as Mitigation[],
    mitigatedAtSimMin: null as number | null,
    timeline: [
      {
        id: 'seed',
        at: Date.now() - profile.startMinAgo * 60_000,
        actor: 'system' as Actor,
        kind: 'observation' as const,
        text: `${profile.incident.id} opened · ${profile.incident.severity} · ${profile.incident.detectedBy}`,
      },
    ],
    denials: [] as DenialEntry[],
    statusPagePosts: [],
    postmortem: null as Postmortem | null,
    flags: { ...DEFAULT_FLAGS },
    replicas: { ...DEFAULT_REPLICAS } as Record<string, number>,
    drainedRegions: [] as string[],
    pagedTeams: [] as string[],
  };
}

/** Diff an agent's original draft against what the operator actually filed,
 *  line by line, so the postmortem can show who wrote what. A line that
 *  survives unchanged from the draft is agent-authored; anything added or
 *  edited by the operator is human-authored. */
function attributeLines(draft: string, final: string): PostmortemLine[] {
  const draftLines = new Set(draft.split('\n').map((l) => l.trim()).filter(Boolean));
  return final.split('\n').map((text) => ({
    text,
    author: text.trim() && draftLines.has(text.trim()) ? 'agent' : 'human',
  }));
}

export const useIncident = create<State>((set, get) => ({
  ...seedFor(SCENARIOS.latency),
  compareMode: false,

  setPhase: (p, by) => {
    set({ phase: p, escalatedBy: p === 'mitigate' ? by : get().escalatedBy });
    get().addEntry({
      actor: by ? 'human' : 'system',
      kind: 'phase',
      text: by
        ? `${by} moved the incident to ${p.toUpperCase()}`
        : `Incident moved to ${p.toUpperCase()}`,
    });
    get().recordDenial('phase_transition', `Phase → ${p.toUpperCase()}${by ? ` (${by})` : ''}`);
  },

  addEntry: (e) => {
    const entry: TimelineEntry = { ...e, id: crypto.randomUUID(), at: Date.now() };
    set((s) => ({ timeline: [...s.timeline, entry] }));
    return entry;
  },

  recordDenial: (kind, text) =>
    set((s) => ({
      denials: [...s.denials, { id: crypto.randomUUID(), atSimMin: s.simMin, kind, text }],
    })),

  applyMitigation: (m) =>
    set((s) => ({
      mitigations: [...s.mitigations, m],
      mitigatedAtSimMin: s.mitigatedAtSimMin ?? s.simMin,
      flags: m.kind === 'flag' ? { ...s.flags, [m.key]: m.enabled } : s.flags,
      replicas: m.kind === 'scale' ? { ...s.replicas, [m.service]: m.replicas } : s.replicas,
      drainedRegions: m.kind === 'drain' ? [...s.drainedRegions, m.region] : s.drainedRegions,
    })),

  postStatus: (body, authoredBy, editedByHuman) =>
    set((s) => ({ statusPagePosts: [...s.statusPagePosts, { at: Date.now(), body, authoredBy, editedByHuman }] })),

  setPostmortem: (draft, final) => set({ postmortem: { lines: attributeLines(draft, final) } }),

  tick: (dtMin) => set((s) => ({ simMin: s.simMin + dtMin })),

  switchScenario: (id) => set({ ...seedFor(SCENARIOS[id]) }),

  setCompareMode: (on) => set({ compareMode: on }),

  reset: () => set((s) => ({ ...seedFor(s.profile) })),
}));
