/**
 * WebMCP integration layer.
 *
 * Three responsibilities:
 *  1. Register / unregister tools in step with React lifecycle (AbortController).
 *  2. Wrap every execute() so calls land in the shared incident ledger.
 *  3. Mirror `toolchange` into React state so the UI can show the live
 *     capability surface — which is the whole point of this product.
 */

import { useEffect, useRef, useState } from 'react';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: any, ctx: { signal?: AbortSignal }) => Promise<string> | string;
}

export const hasWebMCP = () =>
  typeof document !== 'undefined' && !!document.modelContext;

/* ------------------------------------------------------------------ ledger */

export interface LedgerEntry {
  id: string;
  at: number;
  tool: string;
  input: unknown;
  result: string;
  ms: number;
  ok: boolean;
  /** Set when the tool paused for a human. */
  humanInLoop?: boolean;
}

type Listener = (e: LedgerEntry) => void;
const listeners = new Set<Listener>();
export const onToolCall = (fn: Listener) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = (e: LedgerEntry) => listeners.forEach((l) => l(e));

/* ------------------------------------------------------------- registration */

/**
 * Register a tool for as long as `enabled` is true.
 *
 * This is the mechanism the entire product rests on: when the incident phase
 * changes, `enabled` flips, the AbortController fires, and the capability
 * genuinely disappears from the agent's tool list. The agent is not asked not
 * to roll back production. It is structurally unable to.
 */
export function useTool(def: ToolDef | null, enabled = true) {
  const latest = useRef(def);
  latest.current = def;

  useEffect(() => {
    const mc = typeof document !== 'undefined' ? document.modelContext : undefined;
    if (!def || !enabled || !mc) return;
    const controller = new AbortController();
    let dead = false;

    const wrapped: ToolDef = {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
      execute: async (input, ctx) => {
        const t0 = performance.now();
        let result: string;
        let ok = true;
        try {
          result = await latest.current!.execute(input, ctx ?? {});
        } catch (err: any) {
          ok = false;
          result = `Error: ${err?.message ?? 'tool failed'}`;
        }
        emit({
          id: crypto.randomUUID(),
          at: Date.now(),
          tool: def.name,
          input,
          result,
          ms: Math.round(performance.now() - t0),
          ok,
          humanInLoop: performance.now() - t0 > 900, // a pause means a person acted
        });
        return result;
      },
    };

    mc.registerTool(wrapped, { signal: controller.signal })
      .catch((e: unknown) => { if (!dead) console.warn(`[signal] register ${def.name}`, e); });

    return () => { dead = true; controller.abort(); };
  }, [def?.name, enabled]);
}

/* --------------------------------------------------- live capability surface */

export interface LiveTool { name: string; origin?: string }

export function useLiveTools() {
  const [tools, setTools] = useState<LiveTool[]>([]);

  useEffect(() => {
    const mc = typeof document !== 'undefined' ? document.modelContext : undefined;
    if (!mc) return;
    let alive = true;

    const refresh = async () => {
      try {
        const list = await mc.getTools();
        if (alive) setTools(list.map((t) => ({ name: t.name, origin: t.origin })));
      } catch { /* ignore */ }
    };

    mc.addEventListener('toolchange', refresh);
    refresh();
    return () => { alive = false; mc.removeEventListener('toolchange', refresh); };
  }, []);

  return tools;
}

/* ------------------------------------------------------------------ helpers */

/** Let React paint before a tool resolves, so the agent never reads stale UI. */
export const flush = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Errors the model can actually recover from. */
export const toolError = (msg: string, retryHint: string) =>
  `Error: ${msg} ${retryHint}`;
