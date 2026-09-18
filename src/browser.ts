// A browser page driven through one DevTools connection.
//
// Three operations, each as few round trips as the protocol allows:
//   observe()  one Runtime.evaluate returns controls, values, visible text,
//              a page key and per-control guards;
//   act()      checks the target's guard, resolves its current geometry and
//              refuses covered controls, then dispatches trusted input;
//   settle     waits for what the action should produce (two frames, a
//              suggestion list, or a new document) instead of a fixed sleep.
//
// Model output never becomes a selector, a coordinate or script: every
// action names an element that was observed, and input goes to where that
// element is now.

import { Cdp, type CdpOptions } from "./cdp.ts";
import type { ActOutcome, Action, Key, Surface } from "./surface.ts";
import { BrowserConnectionError, StaleObservationError } from "./errors.ts";
import { installObserver, OBSERVER_VERSION, type Observation, type ObservedElement, type PointTarget } from "./page/observer.ts";
import { installOverlay, type OverlayState } from "./page/overlay.ts";

export interface BrowserPageOptions extends CdpOptions {
  /** Viewport used for every page. Default 1280×800 (Solari's default of 800×600 gets mobile layouts). */
  viewport?: { width: number; height: number };
  /** Controls offered per observation. Default 120. */
  maxElements?: number;
  /** Visible text sent with each observation, in characters. Default 4000. */
  maxTextChars?: number;
  /** Longest wait for a suggestion list after typing, in ms. Default 250. */
  suggestionWaitMs?: number;
  /** Longest wait for a new document after an action, in ms. Default 10000. */
  navigationWaitMs?: number;
}

const KEYS: Record<Key, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
};

interface NavigationWatch {
  started: boolean;
  loaded: Promise<void>;
  stop: () => void;
}

type InputEvent = [method: string, params: Record<string, unknown>];

const clickAt = ({ x, y }: PointTarget): InputEvent[] => [
  ["Input.dispatchMouseEvent", { type: "mouseMoved", x, y }],
  ["Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }],
  ["Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }],
];

// `commands` makes select-all independent of platform and keyboard layout.
const SELECT_ALL: InputEvent[] = [
  ["Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }],
  ["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }],
];

const keyPress = (key: Key): InputEvent[] => {
  const { code, keyCode, text } = KEYS[key];
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  return [
    ["Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text ? { text } : {}) }],
    ["Input.dispatchKeyEvent", { type: "keyUp", ...base }],
  ];
};

const INSTALL = `(${installObserver.toString()})(${OBSERVER_VERSION})`;
const MISSING = "__reflex_missing__";

export class BrowserPage implements Surface {
  readonly cdp: Cdp;
  private readonly o: Required<Omit<BrowserPageOptions, keyof CdpOptions>>;

  private mainFrameId = "";

  private constructor(cdp: Cdp, o: BrowserPageOptions) {
    this.cdp = cdp;
    this.o = {
      viewport: o.viewport ?? { width: 1280, height: 800 },
      maxElements: o.maxElements ?? 120,
      maxTextChars: o.maxTextChars ?? 4000,
      suggestionWaitMs: o.suggestionWaitMs ?? 250,
      navigationWaitMs: o.navigationWaitMs ?? 10_000,
    };
  }

  /** Attach to a browser's CDP endpoint and prepare its page. */
  static async connect(cdpEndpoint: string, o: BrowserPageOptions = {}): Promise<BrowserPage> {
    const page = new BrowserPage(await Cdp.connect(cdpEndpoint, o), o);
    const { width, height } = page.o.viewport;
    // Independent setup commands, pipelined into one round trip.
    const tree = page.cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    await Promise.all([
      tree,
      page.cdp.send("Page.enable"),
      page.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      page.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
      // Keeps animation frames and focus behaviour normal in a background tab.
      page.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
      page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL }),
    ]);
    page.mainFrameId = (await tree).frameTree.frame.id;
    return page;
  }

  /**
   * Open a URL and wait for that navigation's own DOMContentLoaded, matched by
   * loader id, so a late event from the previous page cannot end the wait early.
   */
  async navigate(url: string): Promise<void> {
    let loaderId: string | undefined;
    const seen = new Set<string>();
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const stop = this.cdp.on("Page.lifecycleEvent", (p) => {
      if (p.name !== "DOMContentLoaded" || p.frameId !== this.mainFrameId) return;
      seen.add(String(p.loaderId));
      if (loaderId && seen.has(loaderId)) resolveReady();
    });
    const timer = setTimeout(resolveReady, this.o.navigationWaitMs);
    try {
      const r = await this.cdp.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url });
      if (r.errorText) throw new BrowserConnectionError(`Could not open ${url}: ${r.errorText}`);
      // Same-document navigations have no loader id and nothing to wait for.
      if (!r.loaderId) return;
      loaderId = r.loaderId;
      if (seen.has(loaderId)) return;
      await ready;
    } finally {
      clearTimeout(timer);
      stop();
    }
  }

  /** Read the page. Retries briefly while a document is being replaced. */
  async observe(): Promise<Observation> {
    const options = JSON.stringify({ maxElements: this.o.maxElements, maxTextChars: this.o.maxTextChars });
    for (let attempt = 0; attempt < 20; attempt++) {
      const observation = await this.call<Observation | null>(`r.observe(${options})`);
      if (observation) return observation;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new StaleObservationError("The page kept changing and could not be observed");
  }

  /**
   * Dispatch one action against the observation it was chosen from. Throws
   * {@link StaleObservationError} without dispatching anything when the target
   * changed, moved under something else, or disappeared.
   */
  async act(action: Action, observation: Observation): Promise<ActOutcome> {
    const navigation = this.watchNavigation();
    try {
      await this.dispatchAction(action, observation);
      return await this.settle(action, navigation);
    } finally {
      navigation.stop();
    }
  }

  private async dispatchAction(action: Action, observation: Observation): Promise<void> {
    switch (action.kind) {
      case "click":
        await this.dispatch(clickAt(await this.locate(action.element, observation)));
        break;
      case "type":
        // Focus by clicking, replace whatever is there, insert the text: one round trip.
        await this.dispatch([
          ...clickAt(await this.locate(action.element, observation)),
          ...SELECT_ALL,
          ["Input.insertText", { text: action.text }],
          ...(action.submit ? keyPress("Enter") : []),
        ]);
        break;
      case "select": {
        await this.assertFresh(action.element, observation);
        const ok = await this.call<boolean>(`r.choose(${action.element.node}, ${JSON.stringify(action.value)})`);
        if (!ok) throw new StaleObservationError("That option can no longer be chosen");
        break;
      }
      case "press":
        await this.dispatch(keyPress(action.key));
        break;
      case "scroll": {
        const { width, height } = observation.viewport;
        const deltaY = (action.direction === "down" ? 1 : -1) * Math.round(height * 0.7);
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: 0, deltaY });
        break;
      }
      case "wait":
        await new Promise((r) => setTimeout(r, 100));
        break;
    }
  }

  /** Draw the agent's view on the page (numbered boxes, the pick, a status bar). For live views and recordings. */
  async showOverlay(state: OverlayState): Promise<void> {
    await this.cdp.evaluate(`(window.__reflexOverlay ?? (${installOverlay.toString()})()).draw(${JSON.stringify(state)})`).catch(() => undefined);
  }

  /** A screenshot for people (traces, the live view). The decision loop never needs one. */
  async screenshot(o: { quality?: number } = {}): Promise<Uint8Array> {
    const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: o.quality ?? 70 });
    return Buffer.from(data, "base64");
  }

  close(): void {
    this.cdp.close();
  }

  private async assertFresh(element: ObservedElement, observation: Observation): Promise<void> {
    const guard = await this.call<string | null>(`r.guard(${element.node})`);
    if (guard !== observation.guards[element.node]) throw new StaleObservationError(`${element.id} (${element.name}) changed since it was observed`);
  }

  /** Guard check and geometry in one evaluate: the element must be unchanged, enabled and uncovered. */
  private async locate(element: ObservedElement, observation: Observation): Promise<PointTarget> {
    const expected = JSON.stringify(observation.guards[element.node] ?? null);
    const at = await this.call<PointTarget | "stale" | null>(
      `r.guard(${element.node}) !== ${expected} ? "stale" : r.locate(${element.node}, ${element.editable})`);
    if (at === "stale") throw new StaleObservationError(`${element.id} (${element.name}) changed since it was observed`);
    if (!at) throw new StaleObservationError(`${element.id} (${element.name}) is covered, disabled or gone`);
    return at;
  }

  /**
   * Wait for what the action should produce, driven by events rather than
   * sleeps. In the page: two animation frames, or a visible suggestion list
   * after typing into a combobox. If the main frame started loading a new
   * document, wait for that document's DOMContentLoaded instead.
   */
  private async settle(action: Action, navigation: NavigationWatch): Promise<ActOutcome> {
    const node = action.kind === "type" ? action.element.node : null;
    // Resolves to undefined if the document is replaced mid-wait; that is fine.
    await this.call(`r.settle(${node}, ${this.o.suggestionWaitMs})`, { awaitPromise: true }).catch(() => undefined);
    if (!navigation.started) return { navigated: false };
    await navigation.loaded;
    return { navigated: true };
  }

  /** Watch the main frame for a new document, from before an action is dispatched. */
  private watchNavigation(): NavigationWatch {
    let resolveLoaded!: () => void;
    const loaded = new Promise<void>((r) => { resolveLoaded = r; });
    const watch: NavigationWatch = { started: false, loaded, stop: () => {} };
    const stops = [
      this.cdp.on("Page.frameStartedLoading", (p) => { if (p.frameId === this.mainFrameId) watch.started = true; }),
      this.cdp.on("Page.domContentEventFired", () => { if (watch.started) resolveLoaded(); }),
    ];
    const timer = setTimeout(resolveLoaded, this.o.navigationWaitMs);
    watch.stop = () => { clearTimeout(timer); for (const s of stops) s(); };
    return watch;
  }

  /**
   * Send input events back to back and await them together. The browser
   * applies commands in the order sent, so a click is one round trip, not three.
   */
  private async dispatch(events: InputEvent[]): Promise<void> {
    await Promise.all(events.map(([method, params]) => this.cdp.send(method, params)));
  }

  /**
   * Run `body` against the installed observer, bound as `r`. The observer is
   * installed on every new document by the page script; this covers the
   * document that was already open when we attached.
   */
  private async call<T>(body: string, o: { awaitPromise?: boolean } = {}): Promise<T | undefined> {
    const expression = `window.__reflex?.version === ${OBSERVER_VERSION} ? ((r) => ${body})(window.__reflex) : "${MISSING}"`;
    const first = await this.cdp.evaluate<T | typeof MISSING>(expression, o);
    if (first !== MISSING) return first as T | undefined;
    await this.cdp.evaluate(INSTALL);
    return this.cdp.evaluate<T>(expression, o);
  }
}
