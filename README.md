# SIGNAL

**An incident war room where the agent's capabilities are a function of the incident's phase.**

During triage, `rollback_deploy` is not discouraged. It is not registered. It does not appear in the agent's tool list, so the agent cannot call it, cannot hallucinate it, and cannot be talked into it. The only path to write access runs through a human who puts their name on the decision.

Built for [The WebMCP Challenge](https://webmcp.devpost.com/).

**Live:** https://signal-webmcp.pages.dev
**Demo video:** https://youtu.be/XXXXXXXXXXX

---

## The problem

Incident response is the worst possible place to hand an agent a flat set of tools, and the best possible place to have one. Worst, because the tools that help most — rollback, feature flags, traffic shifting — are the tools that turn a SEV-2 into a SEV-1 when fired at the wrong moment. Best, because the actual bottleneck at 3am is a tired human correlating six dashboards under time pressure, which is exactly what a machine is good at.

The industry's current answer is to write "do not roll back production without approval" in a system prompt and hope. That is a request, not a control. Prompts are advisory; a tool that isn't registered is unavailable.

## What SIGNAL does differently

The incident moves through four phases. **The tool surface is recomputed on every phase change.** Because WebMCP registration is tied to component lifecycle through an `AbortController`, capabilities appear and disappear for real, and the `toolchange` event lets the operator watch it happen.

| Phase | Agent can | Agent cannot |
|---|---|---|
| **TRIAGE** | read metrics, search logs, inspect deploys, record hypotheses, ask the operator, request escalation | change anything in production |
| **MITIGATE** | roll back, toggle flags, scale, drain regions, renew certificates, page on-call, publish status updates | escalate itself — a named human already did |
| **RECOVER** | verify recovery, resolve | change production; write tools are withdrawn again |
| **REVIEW** | read the timeline, draft the postmortem | everything else |

The agent discovers this itself. `get_incident_overview` tells it which capabilities it currently holds and that `request_escalation` is the way to ask for more. It reasons about its own permissions rather than bumping into silent failures.

## Three things you cannot build without WebMCP

**1. Tools that render an interface and wait for a person.**
`request_escalation` paints a confirmation surface showing exactly which capabilities will be granted and what the agent intends to do with them. `execute()` does not resolve until the operator decides. A remote MCP server can ask a question; it cannot hand you the decision with the blast radius attached and block on your answer.

**2. Tools that hand work back edited.**
`publish_status_update` gives the operator the agent's draft in a live textarea. They rewrite it. The tool resolves with *their* version, and the return value tells the agent it was edited and what actually went out — so it can match the register on the next update. Co-authorship, not approval.

**3. A capability surface the human can see.**
The left panel lists every tool the agent could ever hold. Registered ones are lit; unregistered ones are struck through. It is fed by `document.modelContext.getTools()` on `toolchange`, so it is the browser's own view of the agent's power, not a mock-up of it.

## Beyond the phase gate

**A memory of what it stopped.** Every `request_escalation`, every declined confirmation and every phase transition lands in a capability-boundary log, separate from the ordinary investigation timeline. The top bar surfaces it as a single count — *N blocked by phase policy* — so the safety boundary isn't just enforced, it's visible.

**A control condition, on demand.** The "compare: no WebMCP" toggle renders the real, live capability panel next to a simulated one where nothing is ever registered — the honest picture of the alternative, where an agent has to screen-scrape the page and guess rather than call a typed tool that structurally does not exist yet.

**Provenance in the postmortem.** `draft_postmortem` keeps the agent's original draft and diffs it line-by-line against what the operator actually filed. The filed postmortem renders with a left-margin dot per line — purple for the agent's own words, green for anything the operator added or rewrote — so the co-authorship claim is visible, not asserted.

**A second incident with a different shape.** SIGNAL ships two scenarios, switchable from the top bar without a reload. `INC-2291` is the original gradual latency cascade, solved by a rollback. `INC-2308` is a sudden edge-gateway TLS certificate expiry — a total outage where every backend service reports *healthy* on error rate while being starved of traffic it never receives, and where `rollback_deploy` is structurally the wrong tool. Confirming this needs `query_metrics` on `rps`, not just a health check, and the deploy that actually caused it (`chore: rotate TLS certs`) is sitting in `list_recent_deploys` for both incidents — background noise in one, the root cause in the other. It's the same tool surface pointed at a real second investigation, not a replayed script.

## Implementation

- **`document.modelContext.registerTool`** for all 21 tools, wrapped in a `useTool` hook that ties registration to React lifecycle. Phase change flips the hook's `enabled` flag, the `AbortController` fires, the capability disappears.
- **`toolchange` + `getTools()`** drive the live capability panel.
- **`AbortSignal`** is threaded from `execute(input, { signal })` into every elicitation surface, so an agent-side or operator-side cancellation tears down the open dialog instead of stranding a promise.
- **`annotations.readOnlyHint`** marks the ten observational tools; `untrustedContentHint` marks `search_logs`, since log content is attacker-influenceable and should be treated as data, not instructions.
- Every tool returns **resulting state, not "OK"**, and every failure returns an **actionable error string** the model can retry against.
- No backend. Telemetry is a deterministic seeded simulation, so the incident behaves identically on every load — which is what makes it demoable and testable.

## Tool reference

| Tool | Phase | Read-only | Notes |
|---|---|---|---|
| `get_incident_overview` | all | ✓ | Reports the agent's own current capabilities |
| `query_metrics` | all | ✓ | ASCII sparkline + baseline/peak, per region |
| `search_logs` | all | ✓ | `untrustedContentHint` |
| `list_recent_deploys` | all | ✓ | |
| `inspect_deploy` | all | ✓ | Behavioural diff, not just a sha |
| `get_service_topology` | all | ✓ | Cause vs. victim |
| `record_hypothesis` | all | | Writes to the shared timeline; requires evidence |
| `ask_operator` | all | | **Renders a picker, blocks** |
| `request_escalation` | triage | | **The gate.** Blocks on a named human |
| `rollback_deploy` | mitigate | | Confirm-gated, shows blast radius |
| `toggle_feature_flag` | mitigate | | Confirm-gated |
| `scale_service` | mitigate | | Confirm-gated |
| `drain_region` | mitigate | | Confirm-gated |
| `renew_certificate` | mitigate | | Confirm-gated; returns a recoverable error outside the cert-expiry incident |
| `page_oncall` | mitigate | | Confirm-gated |
| `publish_status_update` | mitigate | | **Operator edits the draft; agent receives their edit** |
| `declare_mitigated` | mitigate | | Voluntarily withdraws the agent's own write access |
| `verify_recovery` | recover | ✓ | |
| `resolve_incident` | recover | | |
| `get_incident_timeline` | recover, review | ✓ | Human and agent actions interleaved |
| `draft_postmortem` | review | | Operator edits before filing |

## Architecture

```
Browser (no backend, no network calls)
│
├─ store/incident.ts ─────── phase machine + shared timeline (zustand)
│      │                     one object read by BOTH the UI and the tools
│      ▼
├─ webmcp/tools.tsx ──────── 21 tools, each gated on phase
│      │  useTool(def, enabled)
│      ▼
├─ lib/webmcp.ts ─────────── registerTool + AbortController + ledger
│      │                     toolchange → live capability panel
│      ▼
├─ lib/elicitation.tsx ───── confirm | choose | edit surfaces
│                            a Promise the tool awaits
│
└─ lib/telemetry.ts ──────── seeded generator; metrics are a pure function of
                             (service, region, time, mitigations applied)
```

Because telemetry is a pure function of the mitigations applied, rolling back the bad deploy genuinely recovers the curves. There is no second "recovered" dataset — the simulation responds to what the agent actually did.

## Run it

```bash
npm install
npm run dev
```

Then:
1. `chrome://flags/#enable-webmcp-testing` → **Enabled** → relaunch Chrome.
2. Install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd), or open the deployed URL in ChatGPT's in-app browser.
3. Ask your agent: *"checkout is erroring. Find out why."*

Without WebMCP the page still loads and shows the incident read-only, with a banner explaining how to enable agent features.

## Try this script

```
1. "checkout-api is throwing errors. Investigate and tell me what you find."
2. "roll back whatever caused this"          ← the agent will report it has no
                                                such tool and ask to escalate
3. approve the escalation dialog
4. "now roll it back"                        ← confirm the blast radius
5. "post a status update"                    ← edit the agent's draft, watch it
                                                acknowledge your rewrite
6. "declare it mitigated and write the postmortem"
```

Then switch the top bar to **TLS cert expiry** and run it again — same tool surface, a genuinely different root cause, and `rollback_deploy` will not save you this time. Toggle **compare: no WebMCP** at any point to see the same capability panel next to the version of this product that doesn't exist without WebMCP.

## License

MIT — see [LICENSE](./LICENSE).
