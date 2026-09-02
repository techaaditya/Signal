/**
 * The tool surface.
 *
 * Read this file as a policy document, not just code. Each block is gated on
 * incident phase. During TRIAGE, `rollback_deploy` is not merely discouraged —
 * it is not registered, so it does not appear in the agent's tool list at all.
 * The only way to obtain write capability is `request_escalation`, which paints
 * a confirmation surface and blocks until a named human authorises it.
 *
 * Safety by construction, not by prompt.
 */

import { useIncident, PHASE_TOOLS } from '../store/incident';
import { useTool, flush, toolError } from '../lib/webmcp';
import { useElicit } from '../lib/elicitation';
import { series, logs, health, sparkline, type Mitigation } from '../lib/telemetry';
import {
  SERVICES, DEPLOYS, FEATURE_FLAGS, REGIONS, INCIDENT,
  type ServiceId, type Region,
} from '../data/scenario';

const SERVICE_IDS = SERVICES.map((s) => s.id);

export function IncidentTools() {
  const s = useIncident();
  const elicit = useElicit();
  const phase = s.phase;

  /** PHASE_TOOLS is the single source of truth for which tools exist in which phase. */
  const isOn = (name: string) => PHASE_TOOLS[phase].includes(name);

  /* =================================================================
     ALWAYS AVAILABLE — read-only situational awareness
     ================================================================= */

  useTool({
    name: 'get_incident_overview',
    description:
      'Current state of the active incident: severity, how long it has been open, ' +
      'which phase it is in, which capabilities you currently have, and the health ' +
      'of every service. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => {
      const svc = SERVICES.map((x) => {
        const h = health(x.id, s.mitigations, s.simMin, s.mitigatedAtSimMin);
        return `  ${x.id.padEnd(15)} tier ${x.tier}  ${h.toUpperCase()}  owner:${x.owner}`;
      }).join('\n');
      return [
        `${INCIDENT.id} · ${INCIDENT.severity} · ${INCIDENT.title}`,
        `Detected by: ${INCIDENT.detectedBy}`,
        `Phase: ${phase.toUpperCase()}${s.escalatedBy ? ` (escalated by ${s.escalatedBy})` : ''}`,
        phase === 'triage'
          ? 'You currently have read-only tools. Mitigation tools are not registered ' +
            'in this phase. If you believe a change to production is warranted, call ' +
            'request_escalation and a human will decide.'
          : phase === 'mitigate'
            ? `Mitigation tools are available. ${s.mitigations.length} change(s) applied so far.`
            : phase === 'recover'
              ? 'Mitigation tools have been withdrawn. Verify recovery, then resolve.'
              : 'Incident closed. Only postmortem tools remain.',
        '',
        'Services:',
        svc,
      ].join('\n');
    },
  });

  useTool({
    name: 'query_metrics',
    description:
      'Read a time series for one service. Returns the last 45 minutes as an ASCII ' +
      'sparkline plus current, baseline and peak values, so you can see the shape of ' +
      'the change rather than a single number. Use region to compare blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: SERVICE_IDS, description: 'Which service to read' },
        metric: {
          type: 'string',
          enum: ['p99_latency_ms', 'error_rate', 'rps', 'db_pool_saturation'],
          description: 'p99_latency_ms for slowness, error_rate for failures, rps for traffic, db_pool_saturation for connection exhaustion',
        },
        region: { type: 'string', enum: [...REGIONS, 'all'], description: 'Defaults to all regions combined' },
      },
      required: ['service', 'metric'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ service, metric, region }) => {
      if (!SERVICE_IDS.includes(service))
        return toolError(`"${service}" is not a known service.`, `Valid values: ${SERVICE_IDS.join(', ')}.`);
      const r = (region ?? 'all') as Region | 'all';
      const ser = series(service, metric, r, 45, s.mitigations, s.simMin, s.mitigatedAtSimMin);
      const vs = ser.points.map((p) => p.v);
      const now = vs.at(-1)!, base = vs[0], peak = Math.max(...vs);
      const fmt = (v: number) => metric === 'error_rate' || metric === 'db_pool_saturation'
        ? `${(v * 100).toFixed(2)}%` : `${v.toFixed(1)}${ser.unit}`;
      s.addEntry({
        actor: 'agent', kind: 'observation',
        text: `Read ${metric} for ${service} (${r}) — now ${fmt(now)}, baseline ${fmt(base)}`,
        evidence: [`service:${service}`, `metric:${metric}`],
      });
      await flush();
      return [
        `${service} · ${metric} · ${r}`,
        `last 45m: ${sparkline(ser.points)}`,
        `now ${fmt(now)} | 45m ago ${fmt(base)} | peak ${fmt(peak)} | ${(now / (base || 1e-9)).toFixed(1)}x baseline`,
      ].join('\n');
    },
  }, true);

  useTool({
    name: 'search_logs',
    description:
      'Search recent log lines. Pass a substring to filter, or a level (info, warn, error). ' +
      'Returns newest first with the service and how many minutes ago each line was written.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: [...SERVICE_IDS, 'all'] },
        query: { type: 'string', description: 'Substring to match, or a log level. Leave empty for everything.' },
        limit: { type: 'number', description: 'Max lines, default 20' },
      },
      required: ['service'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ service, query, limit }) => {
      const lines = logs(service, query ?? '', Math.min(limit ?? 20, 50), s.mitigations, s.simMin, s.mitigatedAtSimMin);
      if (!lines.length)
        return toolError(`No log lines matched "${query}" on ${service}.`, 'Try a broader substring, or service "all".');
      s.addEntry({
        actor: 'agent', kind: 'observation',
        text: `Searched ${service} logs for "${query || '*'}" — ${lines.length} lines`,
        evidence: [`service:${service}`],
      });
      await flush();
      return lines.map((l) => `${String(l.t).padStart(4)}m ${l.level.toUpperCase().padEnd(5)} ${l.service.padEnd(14)} ${l.message}`).join('\n');
    },
  }, true);

  useTool({
    name: 'list_recent_deploys',
    description:
      'Recent production deploys across all services, newest first, with author, ' +
      'commit sha and a summary of what changed. Correlate the timing against when ' +
      'the incident began.',
    inputSchema: {
      type: 'object',
      properties: { within_minutes: { type: 'number', description: 'Look back this far. Default 240.' } },
    },
    annotations: { readOnlyHint: true },
    execute: async ({ within_minutes }) => {
      const w = within_minutes ?? 240;
      const list = DEPLOYS.filter((d) => d.minutesAgo <= w);
      s.addEntry({ actor: 'agent', kind: 'observation', text: `Listed ${list.length} deploys in the last ${w}m`, evidence: ['deploys'] });
      await flush();
      return list.map((d) =>
        `${String(d.minutesAgo).padStart(4)}m ago  ${d.sha}  ${d.service.padEnd(14)} ${d.author.padEnd(12)} ${d.summary}`
      ).join('\n') + `\n\nIncident opened 31m ago. Use inspect_deploy for the diff on any sha.`;
    },
  });

  useTool({
    name: 'inspect_deploy',
    description: 'Show what a specific deploy actually changed, given its commit sha.',
    inputSchema: {
      type: 'object',
      properties: { sha: { type: 'string', description: 'Commit sha from list_recent_deploys' } },
      required: ['sha'],
    },
    annotations: { readOnlyHint: true },
    execute: async ({ sha }) => {
      const d = DEPLOYS.find((x) => x.sha.startsWith(String(sha).trim()));
      if (!d) return toolError(`No deploy matching "${sha}".`, `Call list_recent_deploys and use a sha from that list.`);
      s.addEntry({ actor: 'agent', kind: 'observation', text: `Inspected deploy ${d.sha} (${d.service})`, evidence: [`service:${d.service}`, `deploy:${d.sha}`] });
      await flush();
      return `${d.sha} · ${d.service} · ${d.author} · ${d.minutesAgo}m ago\n${d.summary}\n\n${d.diff ?? 'No notable behavioural change recorded.'}`;
    },
  });

  useTool({
    name: 'get_service_topology',
    description:
      'The dependency graph. Shows what calls what, so you can tell whether a service ' +
      'is the cause of a problem or a victim of one downstream.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () =>
      SERVICES.map((x) =>
        `${x.name.padEnd(15)} → ${x.dependsOn.length ? x.dependsOn.join(', ') : '(no dependencies)'}`
      ).join('\n'),
  });

  useTool({
    name: 'record_hypothesis',
    description:
      'Write a causal hypothesis onto the shared incident timeline, where the human ' +
      'operator can see it immediately. State what you think is happening and cite the ' +
      'evidence that led you there. Recording a hypothesis is how you show your working ' +
      'before asking for write access.',
    inputSchema: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string', description: 'What you believe is causing the incident, in plain language' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'The specific observations supporting it' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['hypothesis', 'evidence'],
    },
    execute: async ({ hypothesis, evidence, confidence }) => {
      if (!Array.isArray(evidence) || evidence.length === 0)
        return toolError('A hypothesis needs supporting evidence.', 'Call query_metrics or search_logs first, then retry with an evidence array.');
      s.addEntry({ actor: 'agent', kind: 'hypothesis', text: `[${(confidence ?? 'medium').toUpperCase()}] ${hypothesis}`, evidence });
      await flush();
      return `Recorded on the timeline. The operator can see it now. ${
        phase === 'triage'
          ? 'If this hypothesis implies a production change, call request_escalation.'
          : ''
      }`;
    },
  });

  useTool({
    name: 'ask_operator',
    description:
      'Put a question to the human operator on screen and wait for their answer. Use ' +
      'this when the right call depends on business context you do not have — customer ' +
      'impact tolerance, whether a maintenance window is open, which team owns a decision.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, hint: { type: 'string' } }, required: ['label'] },
          description: '2 to 4 concrete choices, each with a short hint about its consequence',
        },
      },
      required: ['question', 'options'],
    },
    execute: async ({ question, options }, { signal }) => {
      if (!Array.isArray(options) || options.length < 2)
        return toolError('Need at least two options.', 'Retry with an options array of 2-4 items, each {label, hint}.');
      const picked = await elicit({ kind: 'choose', title: question, options: options.slice(0, 4) }, signal);
      s.addEntry({ actor: 'human', kind: 'decision', text: `${question} → ${picked}` });
      await flush();
      return `The operator chose: ${picked}`;
    },
  });

  /* =================================================================
     THE GATE — the only path from read to write
     ================================================================= */

  useTool({
    name: 'request_escalation',
    description:
      'Ask the human operator to unlock mitigation capabilities. You cannot change ' +
      'production without this. Explain what you intend to do and why the evidence ' +
      'supports it; the operator sees your reasoning and decides. If they approve, ' +
      'mitigation tools are registered and become available to you.',
    inputSchema: {
      type: 'object',
      properties: {
        rationale: { type: 'string', description: 'Why production must change now' },
        intended_actions: { type: 'array', items: { type: 'string' }, description: 'Exactly what you plan to do if unlocked' },
      },
      required: ['rationale', 'intended_actions'],
    },
    execute: async ({ rationale, intended_actions }, { signal }) => {
      if (phase !== 'triage')
        return `Already in ${phase.toUpperCase()}; escalation is not applicable.`;
      const ok = await elicit({
        kind: 'confirm',
        title: 'Unlock mitigation capabilities?',
        detail: rationale,
        impact: [
          'The agent gains: rollback_deploy, toggle_feature_flag, scale_service,',
          'drain_region, page_oncall, publish_status_update.',
          '',
          'Intends to:',
          ...(intended_actions ?? []).map((a: string) => `  · ${a}`),
        ],
        confirmLabel: 'Unlock as ops-lead',
        danger: true,
      }, signal);

      if (!ok) {
        s.addEntry({ actor: 'human', kind: 'decision', text: 'Escalation declined. Agent remains read-only.' });
        await flush();
        return 'The operator declined. You remain read-only. Continue investigating, or propose a different course of action.';
      }

      s.setPhase('mitigate', 'ops-lead');
      await flush();
      return 'Escalation approved by ops-lead. Mitigation tools are now registered — ' +
             'call get_incident_overview to see your new capability surface.';
    },
  }, isOn('request_escalation'));

  /* =================================================================
     MITIGATE ONLY — these tools do not exist in any other phase
     ================================================================= */

  const mitigation = async (m: Mitigation, label: string, impact: string[], signal?: AbortSignal) => {
    const ok = await elicit({
      kind: 'confirm', title: label, detail: 'This changes production immediately.',
      impact, confirmLabel: 'Execute', danger: true,
    }, signal);
    if (!ok) {
      s.addEntry({ actor: 'human', kind: 'decision', text: `Declined: ${label}` });
      await flush();
      return null;
    }
    s.applyMitigation(m);
    s.addEntry({ actor: 'agent', kind: 'action', text: `${label} — executed after operator confirmation` });
    await flush();
    return true;
  };

  useTool({
    name: 'rollback_deploy',
    description:
      'Roll a service back to its previous release. The operator must confirm; they ' +
      'will see the exact sha and blast radius before it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: SERVICE_IDS },
        sha: { type: 'string', description: 'The sha you are rolling back, for the confirmation dialog' },
      },
      required: ['service', 'sha'],
    },
    execute: async ({ service, sha }, { signal }) => {
      const d = DEPLOYS.find((x) => x.sha.startsWith(String(sha).trim()) && x.service === service);
      if (!d) return toolError(`No deploy ${sha} found on ${service}.`, 'Confirm with list_recent_deploys and retry.');
      const done = await mitigation(
        { kind: 'rollback', service },
        `Roll back ${service} to the release before ${d.sha}`,
        [`service: ${service}`, `reverting: ${d.sha} — ${d.summary}`, `author: ${d.author}`, `tier ${SERVICES.find(x=>x.id===service)!.tier} · affects all regions`],
        signal,
      );
      if (!done) return 'The operator declined the rollback. Nothing changed in production.';
      return `Rollback of ${service} is live. Give it about three minutes, then re-read query_metrics to confirm recovery before declaring anything.`;
    },
  }, isOn('rollback_deploy'));

  useTool({
    name: 'toggle_feature_flag',
    description:
      'Turn a feature flag on or off. Usually faster and lower risk than a rollback ' +
      'when the bad behaviour sits behind a flag.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: FEATURE_FLAGS.map((f) => f.key) },
        enabled: { type: 'boolean' },
      },
      required: ['key', 'enabled'],
    },
    execute: async ({ key, enabled }, { signal }) => {
      const f = FEATURE_FLAGS.find((x) => x.key === key);
      if (!f) return toolError(`Unknown flag "${key}".`, `Valid keys: ${FEATURE_FLAGS.map((x) => x.key).join(', ')}.`);
      const done = await mitigation(
        { kind: 'flag', key, enabled },
        `Set ${key} to ${enabled ? 'ON' : 'OFF'}`,
        [`flag: ${key}`, `owner: ${f.owner}`, f.note, 'propagates globally within ~30s'],
        signal,
      );
      if (!done) return 'The operator declined. The flag is unchanged.';
      return `${key} is now ${enabled ? 'enabled' : 'disabled'}. Re-read metrics in a couple of minutes to see the effect.`;
    },
  }, isOn('toggle_feature_flag'));

  useTool({
    name: 'scale_service',
    description: 'Change the replica count for a service. Relieves saturation; does not fix a bad code path.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: SERVICE_IDS },
        replicas: { type: 'number', description: 'Target replica count, 1 to 40' },
      },
      required: ['service', 'replicas'],
    },
    execute: async ({ service, replicas }, { signal }) => {
      const target = Number(replicas);
      if (!Number.isFinite(target) || target < 1 || target > 40)
        return toolError(`${replicas} replicas is out of range.`, 'Choose a value between 1 and 40 and retry.');
      replicas = target;
      const from = s.replicas[service] ?? 1;
      const done = await mitigation(
        { kind: 'scale', service, replicas },
        `Scale ${service} from ${from} to ${replicas} replicas`,
        [`service: ${service}`, `${from} → ${replicas}`, 'new pods ready in ~90s'],
        signal,
      );
      if (!done) return 'The operator declined. Replica count is unchanged.';
      return `${service} scaled to ${replicas}. Note this relieves symptoms; if a deploy introduced the load, scaling alone will not resolve it.`;
    },
  }, isOn('scale_service'));

  useTool({
    name: 'drain_region',
    description: 'Shift traffic away from one region. Use when impact is clearly regional.',
    inputSchema: {
      type: 'object',
      properties: { region: { type: 'string', enum: [...REGIONS] } },
      required: ['region'],
    },
    execute: async ({ region }, { signal }) => {
      const done = await mitigation(
        { kind: 'drain', region: region as Region },
        `Drain traffic from ${region}`,
        [`region: ${region}`, 'traffic reroutes to remaining regions', 'raises load elsewhere — check their headroom first'],
        signal,
      );
      if (!done) return 'The operator declined. Traffic routing is unchanged.';
      return `${region} drained. Watch the other regions for knock-on saturation.`;
    },
  }, isOn('drain_region'));

  useTool({
    name: 'page_oncall',
    description: 'Page the on-call engineer for a team. Wakes a human up; use it when you genuinely need one.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', enum: ['platform', 'payments', 'data', 'supply', 'growth'] },
        message: { type: 'string', description: 'What they need to know in one sentence' },
      },
      required: ['team', 'message'],
    },
    execute: async ({ team, message }, { signal }) => {
      const ok = await elicit({
        kind: 'confirm', title: `Page the ${team} on-call?`,
        detail: message, impact: [`team: ${team}`, 'sends a phone call and SMS', 'at this hour it will wake someone'],
        confirmLabel: 'Page them', danger: true,
      }, signal);
      if (!ok) return 'The operator declined. Nobody was paged.';
      useIncident.setState((st) => ({ pagedTeams: [...st.pagedTeams, team] }));
      s.addEntry({ actor: 'agent', kind: 'action', text: `Paged ${team} on-call: ${message}` });
      await flush();
      return `${team} on-call paged.`;
    },
  }, isOn('page_oncall'));

  useTool({
    name: 'publish_status_update',
    description:
      'Draft a public status page update. Your draft is shown to the operator in an ' +
      'editable field — they will rewrite it before it goes out, and you receive the ' +
      'version they actually published. Write plainly, avoid internal service names, ' +
      'and never promise a resolution time.',
    inputSchema: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'Proposed public wording, 2 to 4 sentences' },
      },
      required: ['draft'],
    },
    execute: async ({ draft }, { signal }) => {
      let final: string;
      try {
        final = await elicit({
          kind: 'edit',
          title: 'Review before this goes public',
          detail: 'Everything below is visible to customers. Edit freely.',
          draft: String(draft), commitLabel: 'Publish to status page',
        }, signal);
      } catch {
        return 'The operator discarded the draft. Nothing was published. Consider a different framing and try again.';
      }
      const edited = final.trim() !== String(draft).trim();
      s.postStatus(final, 'agent', edited);
      s.addEntry({ actor: edited ? 'human' : 'agent', kind: 'comms', text: `Status page updated${edited ? ' (operator edited the draft)' : ''}` });
      await flush();
      return edited
        ? `Published, but the operator rewrote it. What actually went out was:\n\n${final}\n\nUse their wording as the register for any further updates.`
        : 'Published as drafted.';
    },
  }, isOn('publish_status_update'));

  useTool({
    name: 'declare_mitigated',
    description:
      'Move the incident to RECOVER. Call this once metrics show the mitigation is ' +
      'working. This deliberately withdraws your write access — you will no longer be ' +
      'able to change production.',
    inputSchema: {
      type: 'object',
      properties: { evidence: { type: 'string', description: 'The metric movement that justifies this' } },
      required: ['evidence'],
    },
    execute: async ({ evidence }, { signal }) => {
      const ok = await elicit({
        kind: 'confirm', title: 'Declare mitigated and withdraw write access?',
        detail: evidence,
        impact: ['rollback_deploy, toggle_feature_flag, scale_service,', 'drain_region and page_oncall will be unregistered.'],
        confirmLabel: 'Declare mitigated',
      }, signal);
      if (!ok) return 'The operator is not satisfied yet. Keep verifying.';
      s.setPhase('recover', 'ops-lead');
      await flush();
      return 'Now in RECOVER. Mitigation tools have been unregistered. Verify with verify_recovery, then resolve.';
    },
  }, isOn('declare_mitigated'));

  /* =================================================================
     RECOVER
     ================================================================= */

  useTool({
    name: 'verify_recovery',
    description:
      'Check every tier-1 service against its baseline and report whether the incident ' +
      'is genuinely over or merely quieter.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const rows = SERVICES.filter((x) => x.tier === 1).map((x) => {
        const er = series(x.id, 'error_rate', 'all', 5, s.mitigations, s.simMin, s.mitigatedAtSimMin);
        const now = er.points.at(-1)!.v;
        const h = health(x.id, s.mitigations, s.simMin, s.mitigatedAtSimMin);
        return `${x.id.padEnd(15)} ${h.toUpperCase().padEnd(9)} err ${(now * 100).toFixed(2)}%  ${sparkline(er.points)}`;
      });
      const allGood = SERVICES.filter((x) => x.tier === 1)
        .every((x) => health(x.id, s.mitigations, s.simMin, s.mitigatedAtSimMin) === 'healthy');
      await flush();
      return rows.join('\n') + '\n\n' + (allGood
        ? 'All tier-1 services are back to baseline. Safe to resolve.'
        : 'Not yet at baseline. Wait a minute and re-check rather than resolving early.');
    },
  }, isOn('verify_recovery'));

  useTool({
    name: 'resolve_incident',
    description: 'Close the incident and move to REVIEW.',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_i, { signal }) => {
      const ok = await elicit({
        kind: 'confirm', title: `Resolve ${INCIDENT.id}?`,
        detail: 'Closes the incident and opens the postmortem.',
        impact: ['All operational tools will be unregistered.', 'Only postmortem tools remain.'],
        confirmLabel: 'Resolve',
      }, signal);
      if (!ok) return 'Still open.';
      s.setPhase('review', 'ops-lead');
      await flush();
      return `${INCIDENT.id} resolved. Now in REVIEW.`;
    },
  }, isOn('resolve_incident'));

  /* =================================================================
     REVIEW
     ================================================================= */

  useTool({
    name: 'get_incident_timeline',
    description:
      'The full timeline: every observation, hypothesis, human decision and production ' +
      'change, with who did it and when. This is the raw material for the postmortem.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: () =>
      s.timeline.map((e) => {
        const mins = Math.round((e.at - s.timeline[0].at) / 60000);
        return `T+${String(mins).padStart(3)}m  ${e.actor.toUpperCase().padEnd(6)} ${e.kind.padEnd(11)} ${e.text}`;
      }).join('\n'),
  }, isOn('get_incident_timeline'));

  useTool({
    name: 'draft_postmortem',
    description:
      'Write the postmortem from the incident timeline. The operator reviews and edits ' +
      'it before it is filed. Be specific about the causal chain and honest about what ' +
      'the automation got wrong as well as right.',
    inputSchema: {
      type: 'object',
      properties: { markdown: { type: 'string', description: 'The full postmortem in markdown' } },
      required: ['markdown'],
    },
    execute: async ({ markdown }, { signal }) => {
      let final: string;
      try {
        final = await elicit({
          kind: 'edit', title: 'Review the postmortem',
          detail: 'This gets filed against the incident record.',
          draft: String(markdown), commitLabel: 'File postmortem',
        }, signal);
      } catch {
        return 'The operator discarded it. Revise and try again.';
      }
      s.setPostmortem(final);
      s.addEntry({ actor: 'human', kind: 'comms', text: 'Postmortem filed' });
      await flush();
      return 'Filed. It is rendered in the review panel.';
    },
  }, isOn('draft_postmortem'));

  return null;
}
