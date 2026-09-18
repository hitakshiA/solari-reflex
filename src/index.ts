export { runTask, type RunOptions, type StepRecord, type TaskReport, type TaskStatus } from "./agent.ts";
export { BrowserPage, type BrowserPageOptions } from "./browser.ts";
export type { ActOutcome, Action, Key, Surface } from "./surface.ts";
export { Cdp, type CdpOptions } from "./cdp.ts";
export { DesktopSurface, type DesktopSurfaceOptions } from "./desktop.ts";
export {
  BrowserConnectionError, JevError, ModelError, ReflexError, SolariApiError, StaleObservationError, type JevErrorCode,
} from "./errors.ts";
export {
  DEFAULT_JEV_MODEL, JevClient, MAX_CHOICE_OPTIONS, OPENROUTER_DECISIONS_URL,
  type ChoiceAnswer, type ChoiceQuestion, type JevClientOptions, type JevResult, type NoulAnswer, type NoulQuestion, type Question,
} from "./jev.ts";
export { Advisor, OPENROUTER_CHAT_URL, Planner, TextWriter, type ChatModelOptions, type WrittenText } from "./models.ts";
export type { Observation, ObservedElement, Role } from "./page/observer.ts";
export { overlayFor, type OverlayBox, type OverlayState } from "./page/overlay.ts";
export { BrowserRecorder, type RecorderOptions } from "./recorder.ts";
export { Policy, type Decision, type HistoryEntry, type Offer, type Operation, type PolicyOptions } from "./policy.ts";
export {
  Solari, SOLARI_BASE_URL,
  type BrowserSession, type CreateBrowserOptions, type CreateDesktopOptions, type DesktopSession, type ExecResult, type SolariOptions,
} from "./solari.ts";
