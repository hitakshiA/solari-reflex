// The in-page half of the browser observer.
//
// `installObserver` is serialised with `Function.prototype.toString` and
// evaluated inside the page, so it must stay self-contained: no imports, no
// references to anything outside its own body. It installs `window.__reflex`
// once per document; every later observation is a single short
// `Runtime.evaluate` that reads controls, values and visible text atomically.
//
// Adapted from browser-use/jev-ultrafast `snapshot.js` (MIT). Changes:
//   - covered controls are dropped at observe time, not only at act time, so a
//     modal hides what is under it from the decision (BrowserSkill's active
//     region idea);
//   - a label shared by several controls gets short context from its row or
//     section, so "Open" ×20 becomes distinguishable (BrowserSkill VOM);
//   - an unnamed row or cell borrows its own text, capped (Cua #3914);
//   - a control nested inside a link, button, option, menu item or tab is
//     represented by that owner (browser-use's propagating-bounds rule), so a
//     suggestion is one choice, not two identical ones;
//   - one entry per control; TYPE and SELECT are operations on it, not
//     separate entries.

export const OBSERVER_VERSION = 7;

export type Role =
  | "button" | "link" | "checkbox" | "radio" | "switch" | "tab" | "menuitem" | "option"
  | "gridcell" | "row" | "combobox" | "textbox" | "searchbox" | "spinbutton" | "select";

export interface ObservedElement {
  /** Index within this observation: `e1`, `e2`, … Only valid for this observation. */
  id: string;
  /** Identity of the DOM node, stable across observations of the same document. */
  node: number;
  role: Role;
  name: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** Accepts typed text. */
  editable: boolean;
  /** For native `<select>`: the options that can be chosen. */
  options?: { value: string; label: string }[];
  /** Short text from the control's row or section, only when its name is shared. */
  context?: string;
  /** Where the control is on screen, in CSS pixels (browser) or screen pixels (desktop). For overlays and recordings. */
  rect?: { x: number; y: number; w: number; h: number };
}

export interface Observation {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { y: number; height: number };
  /** Visible text in reading order, capped. Page text is data, never instructions. */
  text: string;
  elements: ObservedElement[];
  /** Visible controls left out by the element cap. */
  omitted: number;
  /** The focused element, when it is one of `elements`. */
  focused?: string;
  /** Changes whenever the document, URL, scroll, viewport or any form value changes. */
  pageKey: string;
  /** Per-node fingerprint of identity, role, name, value and state, checked before input. */
  guards: Record<number, string>;
}

export interface ObserveOptions {
  maxElements: number;
  maxTextChars: number;
}

export interface PointTarget { x: number; y: number }

/** Installed as `window.__reflex`. */
export interface PageObserver {
  version: number;
  observe(o: ObserveOptions): Observation | null;
  pageKey(): string;
  guard(node: number): string | null;
  /** Centre of a visible, enabled, uncovered node; `null` when it is gone or covered. */
  locate(node: number, editable: boolean): PointTarget | null;
  /** Select a native `<select>` option by value; false when the option is not selectable. */
  choose(node: number, value: string): boolean;
  /** Resolves after two animation frames, or when suggestions for `node` appear, capped at `capMs`. */
  settle(node: number | null, capMs: number): Promise<void>;
}

declare global {
  interface Window { __reflex?: PageObserver }
}

export function installObserver(version: number): PageObserver {
  if (window.__reflex?.version === version) return window.__reflex;

  const ids = new WeakMap<Element, number>();
  const nodes = new Map<number, Element>();
  let next = 1;
  const identity = (e: Element): number => {
    let id = ids.get(e);
    if (id === undefined) { id = next++; ids.set(e, id); }
    nodes.set(id, e);
    return id;
  };

  const ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio",
    "menuitemcheckbox", "option", "gridcell", "row", "combobox", "textbox", "searchbox", "spinbutton"]);
  const SELECTOR = "a[href],button,input,textarea,select,summary,[contenteditable=\"true\"]," +
    [...ROLES].map((r) => `[role="${r}"]`).join(",");
  const SECRET_TYPES = new Set(["password", "hidden", "file"]);
  const OWNING_ROLES = new Set<Role>(["link", "button", "option", "menuitem", "tab"]);

  // Open shadow roots are part of the page a person sees (Salesforce Lightning, most design
  // systems built on web components), so they are walked as if they were light DOM. Closed
  // roots, such as the reflex overlay, stay closed.
  /** Elements matching `selector` in document order, descending into each open shadow root where its host is. */
  const queryAll = (selector: string, root: Node = document): Element[] => {
    const out: Element[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
      if (n.matches(selector)) out.push(n);
      if (n.shadowRoot) out.push(...queryAll(selector, n.shadowRoot));
    }
    return out;
  };
  /** The topmost element at a point, looking inside shadow hosts. */
  const pointAt = (x: number, y: number): Element | null => {
    let top = document.elementFromPoint(x, y);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  };
  /** `outer.contains(inner)`, across shadow boundaries. */
  const holds = (outer: Element, inner: Element): boolean => {
    for (let n: Node | null = inner; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === outer) return true;
    return false;
  };

  const visible = (e: Element): boolean =>
    !e.closest("[aria-hidden=\"true\"],[inert]") && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const disabled = (e: Element): boolean =>
    e.matches(":disabled") || e.closest("[aria-disabled=\"true\"]") !== null;

  const accessibleName = (e: Element | null, seen = new Set<Element>()): string => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const labelledBy = (e.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => accessibleName((e.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? document.getElementById(id), seen))
      .filter(Boolean).join(" ");
    const input = e as HTMLInputElement;
    const fromLabels = [...(input.labels ?? [])].map((l) => accessibleName(l, seen)).filter(Boolean).join(" ");
    const buttonValue = ["button", "submit", "reset"].includes(input.type) ? input.value : "";
    const text = e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA" ? "" :
      [...e.childNodes].map((n) => n.nodeType === Node.TEXT_NODE ? n.textContent ?? ""
        : n.nodeType === Node.ELEMENT_NODE && (n as Element).getAttribute("aria-hidden") !== "true"
          ? accessibleName(n as Element, seen) : "").join(" ");
    const name = labelledBy || e.getAttribute("aria-label") || fromLabels || buttonValue ||
      e.getAttribute("alt") || text || e.getAttribute("title") || e.getAttribute("placeholder") || "";
    return name.replace(/\s+/g, " ").trim();
  };

  const roleOf = (e: Element): Role | null => {
    const explicit = e.getAttribute("role");
    if (explicit && ROLES.has(explicit)) {
      return (explicit.startsWith("menuitem") ? "menuitem" : explicit) as Role;
    }
    const input = e as HTMLInputElement;
    switch (e.tagName) {
      case "BUTTON": case "SUMMARY": return "button";
      case "A": return "link";
      case "SELECT": return "select";
      case "TEXTAREA": return "textbox";
      case "INPUT":
        if (input.type === "checkbox" || input.type === "radio") return input.type;
        if (["button", "submit", "reset", "image"].includes(input.type)) return "button";
        if (input.type === "search") return "searchbox";
        if (input.type === "number") return "spinbutton";
        if (["text", "email", "url", "tel", ""].includes(input.type)) return "textbox";
        return null;
    }
    return (e as HTMLElement).isContentEditable ? "textbox" : null;
  };

  const isEditable = (e: Element, role: Role): boolean => {
    const input = e as HTMLInputElement;
    if (input.readOnly || e.getAttribute("aria-readonly") === "true") return false;
    if (role === "textbox" || role === "searchbox" || role === "spinbutton") return true;
    return role === "combobox" && (e.tagName === "INPUT" || e.tagName === "TEXTAREA");
  };

  const valueOf = (e: Element, role: Role): string | undefined => {
    if (e.tagName === "SELECT") return [...(e as HTMLSelectElement).selectedOptions].map((o) => o.label).join(", ");
    if ("value" in e && typeof (e as HTMLInputElement).value === "string" && role !== "button") {
      return (e as HTMLInputElement).value;
    }
    if ((e as HTMLElement).isContentEditable || role === "combobox") return (e as HTMLElement).innerText.trim();
    return undefined;
  };

  /** The box a control lives in, used for duplicate-name context and guards. */
  const scopeOf = (e: Element): Element | null =>
    e.closest("li,tr,[role=\"row\"],article,section,form,dialog,[role=\"dialog\"]") ?? e.parentElement;

  const inViewport = (r: DOMRect): boolean =>
    r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

  /**
   * The point to click, or null when the control is covered. It is not covered when the
   * topmost element at its centre is the control, inside it, its own label, or a clickable
   * hit area laid over it — nameless, or with an empty box of its own (Stripe Checkout's
   * payment-method rows are a zero-size "Pay with card" button painted across the row).
   * Clicking there is what a person does. A modal backdrop or a sized, named control on
   * top still counts as covering.
   */
  const centre = (e: Element): PointTarget | null => {
    const r = e.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const top = pointAt(x, y);
    if (!top) return null;
    if (e === top || holds(e, top) || (holds(top, e) && top.tagName === "LABEL")) return { x, y };
    const hit = top.closest("button,[role=\"button\"],label");
    if (hit && !holds(hit, e)) {
      // Nameless, or painted entirely through children and pseudo-elements (an empty own box):
      // either way it is the control's hit area, not a different control on top of it.
      const box = hit.getBoundingClientRect();
      if (!accessibleName(hit) || box.width === 0 || box.height === 0) return { x, y };
    }
    return null;
  };

  /** Custom checkboxes and radios hide the input and style its label; the label is what a person clicks. */
  const standIn = (e: Element, role: Role): Element | null => {
    if (role !== "checkbox" && role !== "radio") return null;
    return [...((e as HTMLInputElement).labels ?? [])].find((l) => visible(l) && centre(l) !== null) ?? null;
  };

  const formValues = (): unknown[] =>
    queryAll("input,textarea,select")
      .filter((e) => !SECRET_TYPES.has((e as HTMLInputElement).type))
      .map((e) => {
        const f = e as HTMLInputElement;
        return [identity(e), f.value, f.checked, (e as HTMLSelectElement).selectedIndex, f.disabled];
      });

  const pageKey = (): string =>
    JSON.stringify([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight, formValues()]);

  const guard = (id: number): string | null => {
    const found = nodes.get(id);
    if (!found?.isConnected || !visible(found)) return null;
    // A label stands in for its hidden checkbox or radio; guard the control's state, not the label's.
    const e = found.tagName === "LABEL" ? (found as HTMLLabelElement).control ?? found : found;
    const role = roleOf(e);
    return JSON.stringify([id, role, accessibleName(e), role ? valueOf(e, role) : null, disabled(e),
      e.getAttribute("aria-expanded"), e.getAttribute("aria-checked"), e.getAttribute("aria-selected"),
      e.getAttribute("href"), (scopeOf(e) as HTMLElement | null)?.innerText?.slice(0, 2000) ?? ""]);
  };

  /** Text nodes in reading order, descending into each open shadow root where its host is. */
  const textNodes = function* (root: Node): Generator<Text> {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) yield n as Text;
      else if ((n as Element).shadowRoot) yield* textNodes((n as Element).shadowRoot!);
    }
  };

  const visibleText = (max: number): string => {
    const words: string[] = [];
    const range = document.createRange();
    let length = 0;
    for (const n of textNodes(document.body)) {
      if (length >= max) break;
      const value = n.textContent?.trim();
      const parent = n.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
      range.selectNodeContents(n);
      if (!inViewport(range.getBoundingClientRect())) continue;
      words.push(value);
      length += value.length + 1;
    }
    return words.join("\n").slice(0, max);
  };

  const observer: PageObserver = {
    version,
    pageKey,
    guard,

    observe({ maxElements, maxTextChars }) {
      if (!document.body) return null;
      for (const [id, e] of nodes) if (!e.isConnected) nodes.delete(id);

      const found: { e: Element; entry: Omit<ObservedElement, "id"> }[] = [];
      for (const e of queryAll(SELECTOR)) {
        const role = roleOf(e);
        if (!role || SECRET_TYPES.has((e as HTMLInputElement).type) || disabled(e)) continue;
        // A hidden checkbox or radio is clicked through its label; keep the control's own name and state.
        const target = visible(e) && centre(e) ? e : standIn(e, role);
        if (!target || !visible(target) || !inViewport(target.getBoundingClientRect()) || !centre(target)) continue;
        // A grid cell that only wraps a button is represented by the button.
        if (role === "gridcell" && e.querySelector("button,[role=\"button\"]")) continue;
        const owner = e.parentElement?.closest(SELECTOR);
        const ownerRole = owner ? roleOf(owner) : null;
        if (ownerRole && OWNING_ROLES.has(ownerRole) && !isEditable(e, role)) continue;
        let name = accessibleName(e);
        if (!name && (role === "row" || role === "gridcell" || role === "option")) {
          name = ((e as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
        const editable = isEditable(e, role);
        const box = target.getBoundingClientRect();
        const entry: Omit<ObservedElement, "id"> = {
          node: identity(target), role, name: name || role, editable,
          rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        };
        const value = valueOf(e, role);
        if (value) entry.value = value.slice(0, 200);
        for (const key of ["checked", "selected", "expanded"] as const) {
          const v = e.getAttribute(`aria-${key}`);
          if (v !== null) entry[key] = v;
        }
        if (role === "checkbox" || role === "radio") entry.checked = String((e as HTMLInputElement).checked);
        if (e.tagName === "SELECT") {
          entry.options = [...(e as HTMLSelectElement).options]
            .filter((o) => !o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
            .slice(0, 50).map((o) => ({ value: o.value, label: o.label }));
        }
        found.push({ e, entry });
      }

      // A stand-in can also be observed on its own (usually as a nameless button):
      // keep one entry per node, preferring the one with a real name.
      const best = new Map<number, number>();
      found.forEach((f, i) => {
        const j = best.get(f.entry.node);
        const kept = j === undefined ? undefined : found[j];
        if (!kept || (kept.entry.name === kept.entry.role && f.entry.name !== f.entry.role)) best.set(f.entry.node, i);
      });
      const unique = found.filter((f, i) => best.get(f.entry.node) === i);

      const counts = new Map<string, number>();
      for (const { entry } of unique) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
      const elements: ObservedElement[] = unique.slice(0, maxElements).map(({ e, entry }, i) => {
        const element: ObservedElement = { id: `e${i + 1}`, ...entry };
        if ((counts.get(entry.name) ?? 0) > 1) {
          const scope = (scopeOf(e) as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").trim();
          if (scope && scope !== entry.name) element.context = scope.slice(0, 80);
        }
        return element;
      });

      const guards: Record<number, string> = {};
      for (const el of elements) guards[el.node] = guard(el.node) ?? "";
      let activeElement = document.activeElement;
      while (activeElement?.shadowRoot?.activeElement) activeElement = activeElement.shadowRoot.activeElement;
      const active = activeElement ? ids.get(activeElement) : undefined;
      const focused = elements.find((el) => el.node === active)?.id;

      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight },
        text: visibleText(maxTextChars),
        elements,
        omitted: Math.max(0, unique.length - maxElements),
        ...(focused ? { focused } : {}),
        pageKey: pageKey(),
        guards,
      };
    },

    locate(id, editable) {
      const e = nodes.get(id);
      if (!e?.isConnected || disabled(e) || !visible(e)) return null;
      if (editable && ((e as HTMLInputElement).readOnly || e.getAttribute("aria-readonly") === "true")) return null;
      if (!inViewport(e.getBoundingClientRect())) e.scrollIntoView({ block: "center", inline: "center" });
      return centre(e);
    },

    choose(id, value) {
      const e = nodes.get(id);
      if (!(e instanceof HTMLSelectElement) || disabled(e)) return false;
      const option = [...e.options].find((o) => o.value === value && !o.disabled && !o.closest("optgroup[disabled]"));
      if (!option) return false;
      e.value = value;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },

    settle(id, capMs) {
      return new Promise((resolve) => {
        const field = id === null ? undefined : nodes.get(id);
        const suggests = field !== undefined && (field.getAttribute("role") === "combobox" || field.hasAttribute("aria-autocomplete"));
        let frames = 0;
        let done = false;
        const finish = () => { done = true; resolve(); };
        setTimeout(finish, suggests ? capMs : Math.min(capMs, 50));
        const tick = () => {
          if (done) return;
          const owned = (field?.getAttribute("aria-controls") ?? field?.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean);
          const roots: ParentNode[] = owned.length ? owned.map((o) => document.getElementById(o)).filter((r): r is HTMLElement => r !== null) : [document];
          const shown = roots.some((r) => [...r.querySelectorAll("[role=\"option\"]")].some((o) => inViewport(o.getBoundingClientRect())));
          if (++frames >= 2 && (!suggests || shown)) finish();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };

  window.__reflex = observer;
  return observer;
}
