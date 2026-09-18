// An in-page overlay that shows what the agent sees and decides, for live views
// and recordings. It draws every offered control as a numbered box, highlights
// the chosen one with the top alternatives and their probabilities, and keeps a
// status bar (lane, step, elapsed time, spend).
//
// Like the observer, `installOverlay` is serialised and evaluated in the page,
// so it must stay self-contained. It lives in a closed shadow root with
// `pointer-events: none` and `aria-hidden`, so it never intercepts input, never
// changes hit-testing (elementFromPoint skips it) and is never read back by the
// observer.

export interface OverlayBox {
  id: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface OverlayState {
  boxes: OverlayBox[];
  /** The chosen control, drawn highlighted. */
  chosen?: { id: string; operation: string; confidence: number };
  /** Top alternatives for the chosen head: [id, probability]. */
  alternatives?: [string, number][];
  /** Status bar text, e.g. "lane 3 · step 14 · 21.4 s · $0.0021". */
  hud?: string;
  /** "jev" (amber) or "advisor" (violet). */
  source?: "jev" | "advisor";
}

export interface PageOverlay {
  draw(state: OverlayState): void;
  clear(): void;
}

declare global {
  interface Window { __reflexOverlay?: PageOverlay }
}

export function installOverlay(): PageOverlay {
  if (window.__reflexOverlay) return window.__reflexOverlay;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .box{position:fixed;border:1px solid rgba(56,189,248,.55);border-radius:3px;box-sizing:border-box}
    .tag{position:absolute;top:-1px;left:-1px;transform:translateY(-100%);font:600 10px/1.3 ui-monospace,Menlo,monospace;
         color:#0b1220;background:rgba(56,189,248,.85);padding:0 3px;border-radius:3px 3px 0 0;white-space:nowrap}
    .chosen{border:3px solid #f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.25),0 0 24px rgba(245,158,11,.5)}
    .chosen .tag{background:#f59e0b;font-size:12px;padding:1px 5px}
    .advisor.chosen{border-color:#a78bfa;box-shadow:0 0 0 4px rgba(167,139,250,.25)}
    .advisor.chosen .tag{background:#a78bfa}
    .alt{border:2px dashed rgba(245,158,11,.7)}
    .hud{position:fixed;left:12px;bottom:12px;font:600 13px/1.4 ui-monospace,Menlo,monospace;color:#f8fafc;
         background:rgba(2,6,23,.82);border:1px solid rgba(245,158,11,.6);padding:6px 10px;border-radius:8px;max-width:70vw}
    .probs{display:block;font-weight:500;color:#fcd34d;margin-top:2px}`;
  root.appendChild(style);
  const layer = document.createElement("div");
  root.appendChild(layer);
  (document.body ?? document.documentElement).appendChild(host);

  const overlay: PageOverlay = {
    draw(state) {
      layer.replaceChildren();
      if (!host.isConnected) (document.body ?? document.documentElement).appendChild(host);
      const alt = new Set((state.alternatives ?? []).map(([id]) => id));
      for (const b of state.boxes) {
        const d = document.createElement("div");
        const isChosen = state.chosen?.id === b.id;
        d.className = `box${isChosen ? " chosen" : alt.has(b.id) ? " alt" : ""}${state.source === "advisor" ? " advisor" : ""}`;
        d.style.left = `${b.rect.x}px`;
        d.style.top = `${b.rect.y}px`;
        d.style.width = `${Math.max(b.rect.w, 6)}px`;
        d.style.height = `${Math.max(b.rect.h, 6)}px`;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = isChosen ? `${b.id} ${state.chosen?.operation} ${Math.round((state.chosen?.confidence ?? 0) * 100)}%` : b.id;
        d.appendChild(tag);
        layer.appendChild(d);
      }
      if (state.hud) {
        const hud = document.createElement("div");
        hud.className = "hud";
        hud.textContent = state.hud;
        if (state.alternatives?.length) {
          const p = document.createElement("span");
          p.className = "probs";
          p.textContent = state.alternatives.map(([id, v]) => `${id} ${(v * 100).toFixed(0)}%`).join("  ·  ");
          hud.appendChild(p);
        }
        layer.appendChild(hud);
      }
    },
    clear() {
      layer.replaceChildren();
    },
  };
  window.__reflexOverlay = overlay;
  return overlay;
}

/** Overlay state for one decision: every offered control, the pick, and its top alternatives. */
export function overlayFor(
  observation: { elements: { id: string; name: string; rect?: { x: number; y: number; w: number; h: number } }[] },
  decision: { source: "jev" | "advisor"; operation: string; confidence: number; element?: { id: string }; targetProbabilities?: Record<string, number> },
  hud: string,
): OverlayState {
  const boxes = observation.elements
    .filter((e): e is typeof e & { rect: { x: number; y: number; w: number; h: number } } => Boolean(e.rect))
    .map((e) => ({ id: e.id, label: e.name, rect: e.rect }));
  const alternatives = Object.entries(decision.targetProbabilities ?? {})
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => [k.split(":")[0] ?? k, v] as [string, number]);
  return {
    boxes,
    ...(decision.element ? { chosen: { id: decision.element.id, operation: decision.operation, confidence: decision.confidence } } : {}),
    ...(alternatives.length ? { alternatives } : {}),
    hud,
    source: decision.source,
  };
}
