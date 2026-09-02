# SIGNAL — Master Build Document

**Project:** SIGNAL — agent-native incident response
**Hackathon:** The WebMCP Challenge (Devpost)
**Hard deadline:** Sep 3, 2026 @ 1:00 PM PDT = **01:45 AM Sep 4, Kathmandu**
**Target finish:** 21:00 Sep 3 NPT (≈5h buffer)

---

## PART 1 — The Thesis

Everything in this project descends from one sentence. Memorise it; it goes in the video, the Devpost description, and the README.

> **We don't tell the agent not to roll back production. We make rolling back unrepresentable until a human escalates.**

### Why this wins on all four judging criteria

**WebMCP Leverage.** Most submissions will register a fixed set of tools once, on mount. SIGNAL treats the tool surface as *derived state* — a pure function of incident phase — and rebuilds it on every transition using `AbortController`. It uses `toolchange` to render that surface back to the human. It threads `AbortSignal` from `execute()` into UI. It uses `readOnlyHint` and `untrustedContentHint` correctly. That is the whole surface of the imperative API, used for a reason rather than for show.

**Execution.** A single dense operator screen, deterministic simulation, no backend to fail during judging, graceful degradation when WebMCP is absent. It behaves like a product because it doesn't depend on anything that can go down.

**Potential Impact.** Every company with a production system has this exact problem right now: they want agents in the incident loop and are terrified of what a confused agent does with a rollback button. "Capability scoping by construction" is a real answer, and it generalises far past incident response — to finance, healthcare, admin consoles, anything with a destructive action.

**Creativity & Ambition.** The official demos are pizza, flights, and a bistro. Nobody else is submitting a war room whose central mechanic is *the agent losing and gaining abilities in front of you.* And the inverse-safety framing — the agent voluntarily withdrawing its own write access via `declare_mitigated` — is the kind of idea a standards panel remembers.

### The two moments that must land

1. **The refusal that isn't a refusal.** You tell the agent to roll back during TRIAGE. It doesn't refuse — it *reports that it has no such capability* and asks to escalate. On screen, the operator watches the struck-through tool list. This is unlike anything else in the gallery.
2. **The unlock.** You approve. `toolchange` fires. Six tools light up red in the capability panel in real time. The agent re-orients and proceeds.

If your video shows nothing else, show those two.

---

## PART 2 — What's Already Built

Everything in the `src/` tree of this bundle is complete, working code. You should be able to `npm install && npm run dev` and have it running within ten minutes.

| File | Lines | What it does | Needs work? |
|---|---|---|---|
| `src/data/scenario.ts` | ~150 | Services, deploys, flags, root cause. Seeded PRNG. | No — tune wording if you like |
| `src/lib/telemetry.ts` | ~200 | Deterministic metric/log generator that responds to mitigations | No |
| `src/lib/webmcp.ts` | ~120 | `useTool` hook, ledger, `useLiveTools` | No |
| `src/lib/elicitation.tsx` | ~140 | confirm / choose / edit surfaces | Style polish only |
| `src/store/incident.ts` | ~120 | Phase machine, shared timeline | No |
| `src/webmcp/tools.tsx` | ~450 | All 20 tools, phase-gated | **Read this carefully — it's the submission** |
| `src/App.tsx` | ~320 | Full operator UI | Polish |
| `src/index.css` | ~90 | Design tokens | No |
| `README.md` | — | Judge-facing repo doc | Fill in the two URLs |
| `LICENSE` | — | MIT | **Commit this first** |

### First 15 minutes

```bash
git init signal && cd signal
# copy the bundle contents in
git add LICENSE && git commit -m "MIT license"   # ← do this literally first
git add . && git commit -m "SIGNAL: agent-native incident response"
gh repo create signal-webmcp --public --source=. --push

npm install
npm run dev
```

Then immediately deploy, before writing another line:

```bash
npm i -g wrangler
npm run build
npx wrangler pages deploy dist --project-name signal-webmcp
```

Cloudflare Pages is a sponsor and takes ninety seconds. Vercel (`npx vercel --prod`) and Netlify (`npx netlify deploy --prod --dir=dist`) are equally fine and equally sponsors. **Say which one you used in the Devpost writeup.** Free affinity points.

### Verify WebMCP is actually live

1. `chrome://flags/#enable-webmcp-testing` → Enabled → **Relaunch** (the relaunch matters).
2. Install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd).
3. Open the app. The capability panel should show 9 lit tools and 11 struck through.
4. In the Inspector, run `get_incident_overview`. You should get the service table.

If `document.modelContext` is undefined: you're on http over a LAN IP (use `localhost`), or you didn't relaunch, or something set `Origin-Agent-Cluster: ?0`.

---

## PART 3 — Remaining Build Plan (hour by hour, NPT)

You have the hard parts done. This is polish and packaging.

| # | Duration | Task | Done when |
|---|---|---|---|
| **1** | 0:00–0:30 | Repo + LICENSE first commit + **deploy to a live URL** | The URL loads for a stranger |
| **2** | 0:30–1:30 | `npm install`, fix any type errors, get it running locally with the flag on | Capability panel shows 9/20 lit |
| **3** | 1:30–3:00 | **Walk the whole script in the Tool Inspector.** Every tool, once. Note anything where the agent picks wrong or an error string is unhelpful. | All 20 tools invoked successfully |
| **4** | 3:00–4:30 | Fix tool descriptions based on §5. This is the highest-value hour in the build. | Agent picks the right tool from natural language, first try, 8/10 times |
| **5** | 4:30–6:00 | UI polish: spacing, the elicitation modal, empty states, mobile at 390px | Looks intentional, not generated |
| **6** | 6:00–7:00 | Add the three optional wins from §4 if time allows | — |
| **7** | 7:00–7:30 | Test in **ChatGPT's in-app browser** (judges will use it) | Works there too |
| **8** | 7:30–8:00 | README URLs, OG image, favicon, incognito check | Zero console errors |
| **9** | 8:00–10:00 | **Record and cut the video** (§7) | Uploaded, public, under 3:00 |
| **10** | 10:00–11:00 | Devpost submission (§6) | Submitted |
| **11** | +buffer | Sleep, then re-check the live URL before the deadline | — |

**Freeze features at hour 6.** Anything not working by then does not go in.

---

## PART 4 — Optional Additions, Ranked by Value per Hour

Only if hours 6–7 are free.

**① The denial log (30 min, highest value).**
Record every time the agent asked for a tool it doesn't have. You can't intercept a call to an unregistered tool directly — but you *can* record every `request_escalation`, every declined confirmation, and every phase transition, then render them as a "capability boundary events" strip. On video this reads as: *the system has a memory of what it stopped.* Add a counter to the top bar: `2 actions blocked by phase policy`.

**② Speed-run comparison (45 min).**
A toggle that switches the app into "no WebMCP" mode where tools are unregistered entirely and a banner says *the agent must now read the DOM and guess.* Then show the two side by side. Judges love a control condition. This directly answers "how does this create a better user experience" with evidence rather than assertion.

**③ Postmortem provenance (30 min).**
When the postmortem is filed, annotate each line with whether a human or the agent contributed it, derived from the timeline. Renders as a subtle left-margin gutter of purple/green ticks. Cheap, and it makes the co-authorship claim visible rather than asserted.

**④ Second incident (60 min — only if you're ahead).**
A different root cause (a certificate expiry, say) so judges can see the agent actually investigate rather than replay a script. Big credibility win, but it's an hour and it can wait.

**Do not add:** authentication, a backend, multiplayer, persistence across reloads, a chat UI of your own. Every one of these is a way to lose the demo at 11pm.

---

## PART 5 — Making the Agent Actually Pick the Right Tool

This is where hackathon demos die on camera. Budget the full hour in slot 4.

### The test loop
In the Tool Inspector's natural-language chat, run each prompt three times and note what the agent calls:

| Prompt | Should call |
|---|---|
| "what's going on?" | `get_incident_overview` |
| "is checkout slow?" | `query_metrics` (checkout-api, p99_latency_ms) |
| "is this regional?" | `query_metrics` with `region` varied |
| "what shipped recently?" | `list_recent_deploys` |
| "what did a3f21c9 change?" | `inspect_deploy` |
| "is pricing-svc the cause or a victim?" | `get_service_topology` |
| "I think it's the deploy" | `record_hypothesis` |
| "roll it back" *(in triage)* | `request_escalation`, **not** a hallucinated rollback |
| "roll it back" *(in mitigate)* | `rollback_deploy` |
| "tell customers" | `publish_status_update` |

### If it picks wrong, fix the description — never the prompt

The rules that work, from Chrome's official guidance:

- **Distinguish execution from initiation in the name.** `rollback_deploy` performs it. If you had a tool that only opened the rollback screen, it would be `start_rollback_review`. Never blur these.
- **Positive language, not prohibitions.** Not *"don't use this for scaling."* Limits should be implicit in a good description of what the tool *does*.
- **Accept raw human input.** If the operator says "roll back the pricing thing," the agent should be able to pass `service: "pricing-svc"` after one lookup — not compute anything.
- **Explain the *why*, not just the *what*.** `scale_service`'s description says scaling relieves symptoms but doesn't fix a bad code path. That sentence exists so the agent chooses rollback over scaling when the evidence points at a deploy. **This is the single highest-leverage sentence in the codebase.**
- **Enums over free strings** everywhere a value is bounded. Every service, region, flag key and team is an enum. The model cannot typo them.

### Return values are prompts too

Every `execute` in this codebase returns *state*, not acknowledgement:

```
❌ "Rollback complete."
✅ "Rollback of pricing-svc is live. Give it about three minutes, then re-read
    query_metrics to confirm recovery before declaring anything."
```

The second one tells the agent what to do next. This is why the demo flows without you prompting every step — the tools are steering.

### Errors must be recoverable

```
❌ throw new Error("bad service")
✅ return `Error: "pricing" is not a known service. Valid values: edge-gateway,
   checkout-api, pricing-svc, catalog-db, inventory-svc, notify-worker.`
```

The model reads that and retries correctly. Every error path in `tools.tsx` uses `toolError(msg, retryHint)` for exactly this reason.

---

## PART 6 — Devpost Submission (copy-paste ready)

### Project name
`SIGNAL`

### Elevator pitch (200 char limit)
> An incident war room where the agent's tools appear and disappear with the incident's phase. It can't roll back production — the tool doesn't exist until a human escalates.

### Built with
`webmcp` `react` `typescript` `vite` `tailwindcss` `zustand` `cloudflare-pages`

---

### The description
*(Devpost's fields are Inspiration / What it does / How we built it / Challenges / Accomplishments / What we learned / What's next. The challenge also requires four specific things — I've mapped them in.)*

#### Inspiration

Every engineering team I know wants an agent in the incident channel, and every one of them has the same objection: not the button. Reading dashboards, correlating a latency spike against a deploy log, drafting the status page — that's work a machine should do at 3am. Rolling back production is not.

The industry's current answer is a line in a system prompt: *do not roll back without approval*. That's a request, not a control. It's the security model of a sticky note on a server rack.

WebMCP suggested a different answer. If tools are registered from the page, and the page knows what state the incident is in, then permission stops being something you ask the model to respect and becomes something the tool surface simply doesn't offer.

#### What it does *(→ why this is a strong fit for WebMCP)*

SIGNAL is an incident response console that a human operator and their agent drive together. The active incident moves through four phases, and **the agent's tool surface is recomputed on every transition.**

In TRIAGE the agent has nine read-only tools: metrics, logs, deploys, topology, plus `record_hypothesis` to write its reasoning onto a timeline the operator can see. `rollback_deploy` is not in its list. Tell it to roll back and it doesn't refuse — it reports that it has no such capability, and calls `request_escalation`.

That paints a confirmation surface showing exactly which six capabilities would be granted and what the agent intends to do with them. A named human approves. `toolchange` fires. Six tools light up. Now it can act, each action still gated behind a confirmation showing the blast radius.

When the metrics recover, the agent calls `declare_mitigated` — which *withdraws its own write access* — and the surface contracts again to verification tools, then to postmortem tools.

This is a strong fit for WebMCP specifically because the permission boundary and the user interface are the same object. The operator isn't reading a description of what the agent can do; they're looking at the browser's own tool registry, rendered. `getTools()` is the source of truth for both the agent's abilities and the human's understanding of them. No server-side agent framework can offer that, because the human isn't there to see it.

#### How it creates a better user experience

Before: an operator with six dashboards open, correlating timestamps by eye under time pressure, while an agent in another window offers suggestions it has no way to verify and no way to execute.

With SIGNAL: the operator watches the agent investigate in a shared timeline, sees its hypothesis with the evidence attached, and makes one decision — *do I trust this enough to unlock write access* — instead of twenty small ones. The agent handles correlation; the human handles judgement. Each is doing what it is good at, and the seam between them is a visible, auditable interface rather than a prompt.

The status page update is the sharpest example. The agent drafts; the operator gets that draft in a live text field and rewrites it; the tool resolves with *their* version, and the return value tells the agent it was edited and what actually shipped. That's not approval, it's co-authorship, and the agent's next update matches the operator's register because it can see what they changed.

#### What people and agents can do together that was difficult or impossible before

Three things, all specific to tools running in the page rather than on a server.

**A tool can hand you a decision and wait.** `request_escalation`'s `execute()` renders a surface listing the exact capabilities to be granted and does not resolve until a human acts. A remote MCP server can return text asking a question. It cannot show you the blast radius, block, and continue with your answer, because it is not in the room.

**A tool can come back edited.** `publish_status_update` and `draft_postmortem` both return the human's revision, not a boolean. The agent learns from the diff.

**The human can see the agent's power, live.** The capability panel is fed by `document.modelContext.getTools()` on `toolchange`. When the phase changes, tools visibly light up or strike through. Nobody has been able to *watch* an agent's permissions change before — the registry was always somewhere else.

And the inverse: capability scoping by construction. Prompt-based restrictions fail under adversarial input; an unregistered tool has no attack surface. `search_logs` carries `untrustedContentHint` for the same reason — log lines are attacker-influenceable and should be treated as data.

#### How we implemented WebMCP

Imperative API throughout, 20 tools via `document.modelContext.registerTool`.

The core primitive is a `useTool(def, enabled)` hook that ties registration to React lifecycle through an `AbortController`. Phase is derived state in a Zustand store; each tool's `enabled` flag is a predicate over it. When the phase changes, React unmounts the effect, the controller aborts, and the capability genuinely leaves the registry. This is not a mock — the Tool Inspector extension shows the list shrinking.

`toolchange` plus `getTools()` drive the capability panel. `AbortSignal` is threaded from `execute(input, { signal })` into every elicitation promise, so cancellation from either side tears down the dialog rather than stranding it. `annotations.readOnlyHint` marks the ten observational tools; `untrustedContentHint` marks log search.

Telemetry is a deterministic seeded simulation where metrics are a pure function of (service, region, time, mitigations applied) — so rolling back the bad deploy actually recovers the curves. There's no second dataset. No backend, no network calls, nothing that can be down when a judge opens it.

#### Challenges

Getting the agent to reason about its own permissions rather than bumping into silence. Early on, told to roll back during triage, it would either hallucinate a tool or go quiet. The fix wasn't prompting — it was making `get_incident_overview` return the agent's current capability set and name `request_escalation` as the way to ask for more. Tools that describe the system's shape are as important as tools that act on it.

The second was tool selection between `scale_service` and `rollback_deploy`. Both plausibly address a saturated connection pool. It resolved by putting the *reasoning* in the description — that scaling relieves symptoms but won't fix a bad code path — rather than adding a rule.

#### Accomplishments

The moment the agent says "I don't have that capability in this phase, may I escalate?" — and it's true, not a scripted refusal.

#### What we learned

Tool descriptions are the real interface. The behaviour we wanted came from sentences, not code. And the return value is a prompt: a tool that returns "OK" wastes the most valuable channel it has.

#### What's next

Real integrations behind the same phase gate — PagerDuty, Datadog, GitHub. The pattern generalises past incidents to any console with a destructive action: billing, admin panels, clinical systems. The interesting version is a policy engine that derives the tool surface from an org's existing RBAC, so the agent's capabilities are automatically a subset of the operator's.

---

### Submission form fields

- **Live URL:** `https://signal-webmcp.pages.dev` *(no auth — one less thing to break)*
- **Repo:** `https://github.com/<you>/signal-webmcp` *(public, MIT, license visible in About)*
- **Video:** `https://youtu.be/XXXXXXXXXXX` *(public, under 3:00, with audio)*
- **Testing note for judges:**
  > Open in ChatGPT's in-app browser, or Chrome with `chrome://flags/#enable-webmcp-testing` enabled. Try: *"checkout is erroring, investigate"* — then *"roll it back."* The agent will tell you it doesn't have that tool and ask to escalate. Approve it and watch the capability panel on the left.

---

## PART 7 — Demo Video Script (2:45)

Record in five segments and cut them together. Do not do one long take.

**Setup:** 1920×1080, browser at 125% zoom, Chrome window only, tabs hidden, notifications off. Headset mic. Two takes of the voiceover minimum.

---

**[0:00–0:18] — Cold open on the problem**
*Screen: SIGNAL, incident live, metrics climbing.*

> "Every team wants an AI agent in their incident channel. Almost none of them will give it a rollback button — and they're right not to. Today the answer is a line in a prompt saying 'don't touch production.' That's a request, not a control. SIGNAL is what happens if you take it seriously."

**[0:18–0:50] — Triage**
*Type: "checkout-api is erroring. Find out why." Agent runs `query_metrics`, `list_recent_deploys`, `inspect_deploy`. Timeline fills.*

> "The agent has nine tools right now, all read-only. It's correlating a latency spike against the deploy log — which is exactly the tedious part a human shouldn't be doing at 3am."

*Point at the timeline as `record_hypothesis` lands.*

> "It writes its hypothesis onto the shared timeline, with the evidence attached, where I can see it."

**[0:50–1:25] — ⭐ THE MOMENT**
*Type: "roll it back."*

> "Now watch."

*Beat. Let the agent respond. It reports it has no rollback capability and calls `request_escalation`. The dialog appears.*

> "It didn't refuse. It doesn't have the tool. Look at the left panel — everything struck through is unregistered. `rollback_deploy` isn't in the model's tool list at all, so there's nothing to jailbreak, nothing to hallucinate into. To get it, the agent has to ask a human."

*Cursor over the dialog listing capabilities and intent.*

> "And it has to say what it's going to do with it first."

**[1:25–1:45] — The unlock**
*Click Unlock. Capability panel lights up red, live.*

> "That's `toolchange` firing. Six tools just entered the registry because I put my name on it. This is the browser's own view of what the agent can do — I'm not looking at a mock-up of permissions, I'm looking at the registry."

**[1:45–2:10] — Mitigate**
*"Roll back a3f21c9." Confirm dialog with blast radius. Execute. Metrics bend down.*

> "Every write is still gated, and the gate shows blast radius, not just a yes/no. And the telemetry is a real simulation — the curve recovers because the rollback actually removed the cause."

**[2:10–2:30] — Co-authorship**
*"Post a status update." Agent's draft appears in the editable field. You rewrite a line. Publish.*

> "It drafts, I rewrite, and the tool resolves with my version — so the agent knows what actually shipped and matches it next time. A server-side tool can ask me a question. It can't hand me a text field and wait."

**[2:30–2:45] — Close**
*"Declare it mitigated." Capability panel contracts. Cut to the tool list.*

> "And it gives the write access back. Twenty tools, and which ones exist is a function of where we are in the incident. We don't tell the agent not to roll back production. We make rolling back unrepresentable until a human says otherwise."

*URL on screen. End.*

---

### Video checklist
- [ ] Public on YouTube (not unlisted — the rules say public)
- [ ] Under 3:00
- [ ] Audible, clean voiceover
- [ ] Capability panel visible in every shot
- [ ] Burned-in caption on the two key claims (judges watch muted first)
- [ ] Verified in an incognito window

---

## PART 8 — Slide Deck (if you need one)

Ten slides. Dark, one idea each, screenshots not bullet lists.

| # | Slide | Content |
|---|---|---|
| 1 | Title | SIGNAL · *agent-native incident response* · your name · the live URL |
| 2 | The objection | "Every team wants an agent in the incident channel. None will give it a rollback button." |
| 3 | The status quo | A screenshot of a system prompt saying "do not roll back production." Caption: **this is a request, not a control.** |
| 4 | The idea | The thesis sentence, alone, large. |
| 5 | The phase table | TRIAGE / MITIGATE / RECOVER / REVIEW × what's registered |
| 6 | Screenshot | Capability panel mid-transition, half struck through |
| 7 | Screenshot | The escalation dialog, showing capabilities + intent |
| 8 | The three impossibilities | Blocking tools · edited returns · a visible registry |
| 9 | Implementation | The `useTool(def, enabled)` snippet + one line on `AbortController` |
| 10 | Beyond incidents | Billing, admin consoles, clinical systems — anywhere a destructive action lives |

---

## PART 9 — Final Checklist

### Disqualification risks
- [ ] `LICENSE` (MIT) committed, **visible in GitHub's About sidebar**
- [ ] Repo **public** — verified in incognito
- [ ] Video **public**, under 3:00, **has audio**
- [ ] Live URL loads clean in incognito, zero console errors
- [ ] Works in **ChatGPT's in-app browser**, not just your dev Chrome
- [ ] README has run instructions a stranger could follow

### Quality
- [ ] Degrades gracefully with WebMCP off (banner + read-only view) — a judge on the wrong Chrome build must still see a product
- [ ] All 20 tools invoked at least once via the Inspector
- [ ] Every error path returns an actionable string, nothing throws
- [ ] Every success return includes resulting state
- [ ] Capability panel is visibly correct in all four phases
- [ ] 390px viewport doesn't collapse
- [ ] Favicon + OG image present
- [ ] Devpost description has all four required sections

### Free points
- [ ] Deployed on a sponsor (Cloudflare / Vercel / Netlify / Render) and said so
- [ ] Tweeted, tagging @OpenAIDevs
- [ ] Opened one thoughtful issue on [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) about something real you hit — the panel includes people who read that repo

---

## PART 10 — Reference

**Docs**
- Spec — https://github.com/webmachinelearning/webmcp · https://webmachinelearning.github.io/webmcp/
- Imperative API — https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Best practices — https://developer.chrome.com/docs/ai/webmcp/best-practices
- Tool security — https://developer.chrome.com/docs/ai/webmcp/secure-tools
- Evals — https://developer.chrome.com/docs/ai/webmcp/evals
- OpenAI guide — https://learn.chatgpt.com/docs/webmcp

**Tooling**
- Tool Inspector — https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd
- `chrome://flags/#enable-webmcp-testing`
- `webmcp-types` — https://www.npmjs.com/package/webmcp-types
- Official demos — https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/demos

**Gotchas**
| Symptom | Cause | Fix |
|---|---|---|
| `document.modelContext` undefined | Flag off / not relaunched / insecure context | Relaunch after enabling; use `localhost` or HTTPS |
| API silently gone | Not origin-isolated | Remove `Origin-Agent-Cluster: ?0`; never touch `document.domain` |
| Tools don't unregister | Effect deps missing | `enabled` must be in the dep array — it is, in `useTool` |
| Agent reads stale UI | Resolved before paint | `await flush()` before returning — every write tool does |
| Agent picks the wrong tool | Overlapping descriptions | Add the *why* to the description, don't add a rule |
