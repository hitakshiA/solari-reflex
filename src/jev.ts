// Client for Jev, TypeSafe's System One decision model.
//
// A request is a `state` plus named, typed questions; every question is
// answered in parallel against one prefill, so asking more questions costs
// input tokens but barely any latency. That is what makes speculative
// fan-out cheap: ask for the operation and for a target under every
// operation in the same round trip, then use only the head that applies.
//
// Answers are validated before they are returned. A choice that was not
// offered, or probabilities that do not describe the offered options, is a
// malformed response, never a best guess.

import { JevError, jevErrorForStatus } from "./errors.ts";

/** OpenRouter's Decisions API. TypeSafe's own endpoint is `https://api.typesafe.ai/v1/systemone`. */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_JEV_MODEL = "~typesafe/jev-latest";

/** Choice allows at most this many options per question. */
export const MAX_CHOICE_OPTIONS = 255;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: "choice";
  instructions: JsonValue;
  /** Option key → rubric. `null` when the key speaks for itself. */
  criteria: Record<string, JsonValue>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: JsonValue;
  criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion ? ChoiceAnswer : NoulAnswer;

export interface JevUsage {
  inputTokens: number;
  /** USD, when the gateway reports it. */
  cost?: number;
}

export interface JevResult<Q extends Record<string, Question>> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  /** The versioned model that answered, e.g. `typesafe/jev-1.13-20260917`. */
  model: string;
  usage: JevUsage;
  latencyMs: number;
}

export interface JevClientOptions {
  apiKey: string;
  /** Decisions endpoint. Default {@link OPENROUTER_DECISIONS_URL}. */
  url?: string;
  /** Default {@link DEFAULT_JEV_MODEL}. Pin a versioned id to freeze calibration. */
  model?: string;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Retries for 429 / 5xx only, with exponential backoff from 250 ms. Default 2. */
  maxRetries?: number;
  /** Optional `fetch` implementation (defaults to the global). */
  fetch?: typeof fetch;
}

export class JevClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: JevClientOptions) {
    if (!o.apiKey) throw new JevError("jev_unauthorized", "No API key was given");
    this.apiKey = o.apiKey;
    this.url = o.url ?? OPENROUTER_DECISIONS_URL;
    this.model = o.model ?? DEFAULT_JEV_MODEL;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxRetries = o.maxRetries ?? 2;
    this.fetchImpl = o.fetch ?? globalThis.fetch;
  }

  /** Ask every question about one state in a single request. */
  async ask<Q extends Record<string, Question>>(state: JsonValue, questions: Q): Promise<JevResult<Q>> {
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const n = Object.keys(q.criteria).length;
        if (n < 1 || n > MAX_CHOICE_OPTIONS) {
          throw new JevError("jev_rejected_request", `Question "${id}" offers ${n} options; 1–${MAX_CHOICE_OPTIONS} are allowed`);
        }
      }
    }
    const body = JSON.stringify({ model: this.model, state, questions });
    const started = performance.now();
    const raw = await this.post(body);
    return { ...decode(raw, questions), latencyMs: Math.round(performance.now() - started) };
  }

  private async post(body: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        throw new JevError("jev_unreachable", `Could not reach ${new URL(this.url).host}: ${(e as Error).message}`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await response.body?.cancel();
        await sleep(250 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw jevErrorForStatus(response.status, text);
      try {
        return JSON.parse(text);
      } catch {
        throw new JevError("jev_malformed_response", "The response was not JSON");
      }
    }
  }
}

/** Validate the envelope and every answer against the question that produced it. */
function decode<Q extends Record<string, Question>>(raw: unknown, questions: Q): Omit<JevResult<Q>, "latencyMs"> {
  const malformed = (why: string) => new JevError("jev_malformed_response", why);
  if (!isRecord(raw) || !isRecord(raw.answers)) throw malformed("The response has no answers");
  const answers: Record<string, ChoiceAnswer | NoulAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const a = raw.answers[id];
    if (!isRecord(a)) throw malformed(`No answer for "${id}"`);
    if (question.type === "noul") {
      if (!isProbability(a.noul)) throw malformed(`"${id}" is not a probability`);
      answers[id] = { type: "noul", noul: a.noul };
      continue;
    }
    const offered = Object.keys(question.criteria);
    const p = a.probabilities;
    const valid =
      typeof a.choice === "string" && offered.includes(a.choice) &&
      isRecord(p) && Object.keys(p).length === offered.length &&
      offered.every((k) => isProbability(p[k])) &&
      Math.abs(offered.reduce((sum, k) => sum + (p[k] as number), 0) - 1) < 0.02 &&
      isProbability(a.confidence);
    if (!valid) throw malformed(`"${id}" chose an option that was not offered, or its probabilities do not describe the offer`);
    answers[id] = {
      type: "choice",
      choice: a.choice as string,
      probabilities: p as Record<string, number>,
      confidence: a.confidence as number,
    };
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    answers: answers as JevResult<Q>["answers"],
    model: typeof raw.model === "string" ? raw.model : "unknown",
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
