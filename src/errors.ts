// Typed errors. Callers branch on `instanceof` or on the stable `code`; the
// message is for people. Every Jev failure means the same thing to the caller:
// no input was dispatched, decide this step some other way.

/** Base class for every error thrown by solari-reflex. */
export class ReflexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Stable codes for a Jev call that produced no usable decision. */
export type JevErrorCode =
  | "jev_unauthorized"
  | "jev_payment_required"
  | "jev_rate_limited"
  | "jev_upstream_unavailable"
  | "jev_rejected_request"
  | "jev_unreachable"
  | "jev_malformed_response";

/** The decision model could not answer. Nothing was dispatched to the machine. */
export class JevError extends ReflexError {
  readonly code: JevErrorCode;
  readonly status: number | undefined;
  constructor(code: JevErrorCode, message: string, status?: number) {
    super(`${message} (${code}); no action was dispatched, decide this step another way`);
    this.code = code;
    this.status = status;
  }
}

/** Map a non-2xx decision response onto its stable code. */
export function jevErrorForStatus(status: number, detail: string): JevError {
  const code: JevErrorCode =
    status === 401 || status === 403 ? "jev_unauthorized"
    : status === 402 ? "jev_payment_required"
    : status === 429 ? "jev_rate_limited"
    : status >= 500 ? "jev_upstream_unavailable"
    : "jev_rejected_request";
  // Truncated: a rejected body can echo the whole request back.
  return new JevError(code, `Jev returned HTTP ${status}: ${detail.slice(0, 200)}`, status);
}

/** A Solari control-plane request failed. */
export class SolariApiError extends ReflexError {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The page changed after it was observed, so the decision no longer refers to it. */
export class StaleObservationError extends ReflexError {
  constructor(message = "The page changed since it was observed; observe again") {
    super(message);
  }
}

/** The DevTools connection to the browser closed or never opened. */
export class BrowserConnectionError extends ReflexError {}

/** A text-writing or escalation model call failed. */
export class ModelError extends ReflexError {
  readonly model: string;
  constructor(model: string, message: string) {
    super(`${model}: ${message}`);
    this.model = model;
  }
}
