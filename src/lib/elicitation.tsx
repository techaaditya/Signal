/**
 * Human-in-the-loop elicitation.
 *
 * This is the capability that only exists because WebMCP tools run inside the
 * page the operator is already looking at. A tool's execute() paints a real
 * surface, blocks, and resolves with what the human did. A remote MCP server
 * can ask a question; it cannot hand you a slider and wait.
 *
 * Three surfaces:
 *   confirm  — a gate on a destructive action, showing exact blast radius
 *   choose   — the operator picks between agent-proposed options
 *   edit     — the operator rewrites agent-drafted text before it goes out
 */

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

export type ElicitRequest =
  | { kind: 'confirm'; title: string; detail: string; impact: string[]; confirmLabel: string; danger?: boolean }
  | { kind: 'choose'; title: string; detail?: string; options: { label: string; hint?: string }[] }
  | { kind: 'edit'; title: string; detail?: string; draft: string; commitLabel: string };

interface Pending { id: number; req: ElicitRequest; settle: (v: any) => void; fail: (e: Error) => void }

const Ctx = createContext<{
  elicit: (req: ElicitRequest, signal?: AbortSignal) => Promise<any>;
  pending: Pending | null;
} | null>(null);

/**
 * Multiple tool calls can request elicitation concurrently — e.g. the agent
 * fires two confirm-gated mitigations back to back. Only one surface can be
 * on screen at a time, so requests queue and are shown one after another
 * rather than the newest silently stranding the previous caller's promise.
 */
export function ElicitationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const nextId = useRef(0);

  /** Dismiss `p` (whether active or still queued) and promote the next one. */
  const dismiss = (p: Pending) => {
    setPending((cur) => {
      if (cur?.id !== p.id) {
        // p was still waiting in the queue (e.g. aborted before its turn).
        queue.current = queue.current.filter((q) => q.id !== p.id);
        return cur;
      }
      return queue.current.shift() ?? null;
    });
  };

  const elicit = (req: ElicitRequest, signal?: AbortSignal) =>
    new Promise<any>((resolve, reject) => {
      const p: Pending = {
        id: nextId.current++,
        req,
        settle: (v) => { dismiss(p); resolve(v); },
        fail: (e) => { dismiss(p); reject(e); },
      };
      if (signal) {
        const onAbort = () => p.fail(new Error('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      setPending((cur) => {
        if (cur === null) return p;
        queue.current.push(p);
        return cur;
      });
    });

  return (
    <Ctx.Provider value={{ elicit, pending }}>
      {children}
      {pending && <ElicitSurface key={pending.id} pending={pending} />}
    </Ctx.Provider>
  );
}

export function useElicit() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ElicitationProvider is missing');
  return c.elicit;
}

/* ------------------------------------------------------------------- surface */

function ElicitSurface({ pending }: { pending: Pending }) {
  const { req, settle: resolve, fail: reject } = pending;
  const [draft, setDraft] = useState(req.kind === 'edit' ? req.draft : '');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm">
      <div className="w-[min(560px,92vw)] border border-line bg-panel">
        {/* Explicit provenance: the operator must always know an agent asked. */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[11px] uppercase tracking-[0.14em] text-dim">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
          Agent is waiting on you
        </div>

        <div className="px-5 py-4">
          <h3 className="text-[15px] font-medium text-fg">{req.title}</h3>
          {'detail' in req && req.detail && (
            <p className="mt-1.5 text-[13px] leading-relaxed text-dim">{req.detail}</p>
          )}

          {req.kind === 'confirm' && (
            <ul className="mt-4 space-y-1 border-l-2 border-red pl-3 font-mono text-[12px] text-fg">
              {req.impact.map((i) => <li key={i}>{i}</li>)}
            </ul>
          )}

          {req.kind === 'edit' && (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              className="mt-4 w-full resize-y border border-line bg-bg p-3 font-mono text-[12.5px] leading-relaxed text-fg outline-none focus:border-acc"
            />
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
          {req.kind === 'confirm' && (
            <>
              <button onClick={() => resolve(true)}
                className={`px-4 py-2 text-[13px] font-medium ${req.danger ? 'bg-red text-bg' : 'bg-acc text-bg'}`}>
                {req.confirmLabel}
              </button>
              <button onClick={() => resolve(false)} className="btn-ghost">Cancel</button>
            </>
          )}

          {req.kind === 'choose' && req.options.map((o) => (
            <button key={o.label} onClick={() => resolve(o.label)}
              className="btn-ghost flex flex-col items-start text-left">
              <span className="text-fg">{o.label}</span>
              {o.hint && <span className="text-[11px] text-dim">{o.hint}</span>}
            </button>
          ))}

          {req.kind === 'edit' && (
            <>
              <button onClick={() => resolve(draft)} className="bg-acc px-4 py-2 text-[13px] font-medium text-bg">
                {req.commitLabel}
              </button>
              <button onClick={() => reject(new Error('operator discarded the draft'))} className="btn-ghost">
                Discard
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
