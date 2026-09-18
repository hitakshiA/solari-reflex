// What the agent loop drives. A browser page and a desktop both read the screen
// as the same Observation (numbered controls, visible text, a page key and a
// guard per control) and accept the same Actions, so one loop, one policy and
// one report serve both.

import type { Observation, ObservedElement } from "./page/observer.ts";

export type Key = "Enter" | "Escape" | "Tab";

export type Action =
  | { kind: "click"; element: ObservedElement }
  /** Replace the control's text; `submit` presses Enter afterwards, with real key input. */
  | { kind: "type"; element: ObservedElement; text: string; submit?: boolean }
  | { kind: "select"; element: ObservedElement; value: string }
  | { kind: "press"; key: Key }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "wait" };

/** How an action ended up affecting the screen. */
export interface ActOutcome {
  /** A new document (browser) or a new active window (desktop) appeared. */
  navigated: boolean;
}

export interface Surface {
  /** Read the screen as numbered controls. */
  observe(): Promise<Observation>;
  /**
   * Dispatch one action against the observation it was chosen from. Throws
   * StaleObservationError, without dispatching anything, when the target changed.
   */
  act(action: Action, observation: Observation): Promise<ActOutcome>;
  /** A JPEG for people: traces, recordings, the live view. The loop never needs one. */
  screenshot(o?: { quality?: number }): Promise<Uint8Array>;
}
