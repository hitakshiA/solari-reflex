// The loop: observe → decide → (write) → act → settle, one step at a time,
// with no generative model in the common path.
//
//   confidence ≥ actAt        act on Jev's pick
//   confidence < actAt        ask the Advisor, choosing from the same offer;
//                             without one, stop and hand back ("needs_help")
//
// With a Planner, the goal is turned into an ordered checklist once and Jev
// works one step at a time, reading in the same request whether the current
// step is already done (then the checklist moves on without acting).
// `done` and `blocked` are read independently of the pick. A stale target is
// never retried blindly: the page is observed again and the step is decided
// again. Three actions in a row that change nothing, or six that alternate
// between the same two, are treated as blocked.
// The report keeps observation, decision, writing and action time apart so a
// run can be compared phase by phase (the shape jev-use reports).

import type { Action, Surface } from "./surface.ts";
import { ModelError, ReflexError, StaleObservationError } from "./errors.ts";
import type { Advisor, Planner, TextWriter } from "./models.ts";
import type { Observation } from "./page/observer.ts";
import type { Decision, HistoryEntry, Policy } from "./policy.ts";

export type TaskStatus = "done" | "blocked" | "needs_help" | "budget_exhausted";

export interface StepRecord {
  step: number;
  action: string;
  decidedBy: "jev" | "advisor";
  confidence: number;
  done: number;
  blocked: number;
  text?: string;
  pageChanged: boolean;
  url: string;
  /** Milliseconds since the task started, when the action finished settling. */
  atMs: number;
  observeMs: number;
  decideMs: number;
  writeMs: number;
  actMs: number;
}

/** Every decision made, including ones that ended the task or went to the Advisor. */
export interface DecisionRecord {
  source: "jev" | "advisor";
  operation: string;
  target?: string;
  confidence: number;
  done: number;
  blocked: number;
  /** Top three operations and targets by probability. */
  operations: [string, number][];
  targets?: [string, number][];
  latencyMs: number;
}

export interface TaskReport {
  status: TaskStatus;
  reason?: string;
  steps: StepRecord[];
  decisions: DecisionRecord[];
  /** The checklist from the planner, when one was used, and how far the task got through it. */
  plan?: { steps: string[]; finish?: string; reached: number; ms: number };
  /** Totals for the whole task, in ms. */
  timings: { totalMs: number; observeMs: number; decideMs: number; writeMs: number; actMs: number };
  usage: { jevCalls: number; jevInputTokens: number; advisorCalls: number; writerCalls: number; costUsd: number };
  staleRetries: number;
  finalUrl: string;
}

export interface RunOptions {
  /** A BrowserPage or a DesktopSurface. */
  page: Surface;
  policy: Policy;
  writer: TextWriter;
  /** Consulted when Jev's confidence is below `actAt`. Without it, those steps hand back. */
  advisor?: Advisor;
  /** Turns the goal into an ordered checklist once; Jev then works one step at a time. */
  planner?: Planner;
  goal: string;
  /** Action budget. Default 30. */
  maxSteps?: number;
  /** Act on Jev's pick at or above this confidence. Default 0.6. */
  actAt?: number;
  /** Stop as done at or above this P(done). Default 0.8. */
  doneAt?: number;
  /**
   * Move the checklist on at or above this P(step done). Default 0.6: a finished step
   * often leaves nothing to point at (an applied code replaces its field), so the bar
   * is lower than for finishing the whole task.
   */
  stepDoneAt?: number;
  /** Stop as blocked at or above this P(blocked). Default 0.85. */
  blockedAt?: number;
  /** Stale targets tolerated before handing back. Default 6. */
  maxStaleRetries?: number;
  /** Called after every decision, before it is acted on (for overlays and live views). */
  onDecision?: (decision: Decision, observation: Observation, elapsedMs: number) => void | Promise<void>;
  /** Called after every executed step. */
  onStep?: (step: StepRecord, observation: Observation) => void | Promise<void>;
}

export async function runTask(o: RunOptions): Promise<TaskReport> {
  const maxSteps = o.maxSteps ?? 30;
  const actAt = o.actAt ?? 0.6;
  const doneAt = o.doneAt ?? 0.8;
  const stepDoneAt = o.stepDoneAt ?? 0.6;
  const blockedAt = o.blockedAt ?? 0.85;
  const maxStaleRetries = o.maxStaleRetries ?? 6;

  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  const history: HistoryEntry[] = [];
  const report: TaskReport = {
    status: "budget_exhausted",
    steps: [],
    decisions: [],
    timings: { totalMs: 0, observeMs: 0, decideMs: 0, writeMs: 0, actMs: 0 },
    usage: { jevCalls: 0, jevInputTokens: 0, advisorCalls: 0, writerCalls: 0, costUsd: 0 },
    staleRetries: 0,
    finalUrl: "",
  };
  const timed = async <T>(phase: "observeMs" | "decideMs" | "writeMs" | "actMs", fn: () => Promise<T>): Promise<[T, number]> => {
    const t = performance.now();
    try {
      const value = await fn();
      return [value, Math.round(performance.now() - t)];
    } finally {
      report.timings[phase] += Math.round(performance.now() - t);
    }
  };

  let [observation, observeMs] = await timed("observeMs", () => o.page.observe());
  let plan: string[] = [];
  let finish: string | undefined;
  let stepIndex = 0;
  if (o.planner) {
    const t0 = performance.now();
    const p = await o.planner.plan(o.goal, observation);
    report.usage.costUsd += p.cost ?? 0;
    plan = p.steps;
    finish = p.finish;
    report.plan = { steps: plan, ...(finish ? { finish } : {}), reached: 0, ms: Math.round(performance.now() - t0) };
  }
  const currentStep = () => plan[stepIndex];
  // A text value survives a stale retry only if the field it was written for is unchanged.
  let written: { key: string; text: string } | undefined;
  // Toggles clicked on the last step are not offered for clicking again on the next.
  let justToggled = new Set<number>();

  try {
    while (report.steps.length < maxSteps) {
      const [decision, decideMs] = await timed("decideMs", () =>
        decide(o, observation, history, { actAt, doneAt, stepDoneAt, blockedAt }, report, currentStep(), finish, justToggled));

      // A finished plan step moves the checklist on without acting; the next step is decided fresh.
      if (currentStep() && (decision.stepDone ?? 0) >= stepDoneAt && stepIndex < plan.length - 1) {
        stepIndex++;
        if (report.plan) report.plan.reached = stepIndex;
        history.push({ action: `STEP DONE: ${plan[stepIndex - 1]}`, pageChanged: false });
        continue;
      }
      if (decision.done >= doneAt && (!plan.length || stepIndex >= plan.length - 1)) { report.status = "done"; break; }
      if (decision.blocked >= blockedAt) { report.status = "blocked"; report.reason = "The page offers no way forward"; break; }
      if (decision.confidence < actAt) {
        report.status = "needs_help";
        report.reason = `Jev confidence ${decision.confidence.toFixed(2)} is too low to act`;
        break;
      }

      await o.onDecision?.(decision, observation, since());

      let writeMs = 0;
      let text: string | undefined;
      const field = decision.operation === "TYPE" ? decision.element : undefined;
      if (field) {
        const key = `${field.node}:${observation.guards[field.node] ?? ""}`;
        if (written?.key !== key) {
          const aim = currentStep() ? `${currentStep()} (one step of: ${o.goal})` : o.goal;
          // One retry: a small model occasionally returns something that is not JSON.
          const [w, ms] = await timed("writeMs", () =>
            o.writer.write(aim, field, observation, history).catch(() => o.writer.write(aim, field, observation, history)));
          report.usage.writerCalls++;
          report.usage.costUsd += w.cost ?? 0;
          written = { key, text: w.text };
          writeMs = ms;
        }
        text = written.text;
      }

      const action = toAction(decision, text);
      try {
        const [outcome, actMs] = await timed("actMs", () => o.page.act(action, observation));
        justToggled = action.kind === "click" && ["checkbox", "radio", "switch"].includes(action.element.role)
          ? new Set([action.element.node]) : new Set();
        const before = observation;
        [observation, observeMs] = await timed("observeMs", () => o.page.observe());
        written = undefined;
        const pageChanged = outcome.navigated || observation.pageKey !== before.pageKey || observation.text !== before.text;
        const label = describeAction(decision, text) + changeOf(action, observation);
        history.push({ action: label, pageChanged });
        const record: StepRecord = {
          step: report.steps.length + 1,
          action: label,
          decidedBy: decision.source,
          confidence: round(decision.confidence),
          done: round(decision.done),
          blocked: round(decision.blocked),
          ...(text !== undefined ? { text } : {}),
          pageChanged,
          url: observation.url,
          atMs: since(),
          observeMs,
          decideMs,
          writeMs,
          actMs,
        };
        report.steps.push(record);
        await o.onStep?.(record, observation);

        const lastThree = history.slice(-3);
        if (lastThree.length === 3 && lastThree.every((h) => !h.pageChanged && !h.action.startsWith("WAIT"))) {
          report.status = "blocked";
          report.reason = "Three actions in a row changed nothing";
          break;
        }
        // Going back and forth (scroll down, scroll up, down, up…) changes the page but gets nowhere.
        const lastSix = history.slice(-6).map((h) => h.action);
        if (lastSix.length === 6 && new Set(lastSix).size <= 2 && lastSix.every((a, i) => i < 2 || a === lastSix[i - 2])) {
          report.status = "blocked";
          report.reason = `Going back and forth between ${[...new Set(lastSix)].join(" and ")}`;
          break;
        }
      } catch (e) {
        if (!(e instanceof StaleObservationError)) throw e;
        // Nothing was dispatched. Look again and decide again.
        if (++report.staleRetries > maxStaleRetries) {
          report.status = "needs_help";
          report.reason = "The page kept changing under every decision";
          break;
        }
        [observation, observeMs] = await timed("observeMs", () => o.page.observe());
      }
    }
  } catch (e) {
    if (!(e instanceof ReflexError)) throw e;
    report.status = "needs_help";
    report.reason = e.message;
  }

  report.finalUrl = observation.url;
  report.timings.totalMs = since();
  return report;
}

async function decide(
  o: RunOptions, observation: Observation, history: readonly HistoryEntry[],
  gates: { actAt: number; doneAt: number; stepDoneAt: number; blockedAt: number }, report: TaskReport, step?: string, finish?: string,
  justToggled?: ReadonlySet<number>,
): Promise<Decision> {
  const decision = await o.policy.decide(o.goal, observation, history, step, finish, justToggled);
  report.decisions.push(record(decision));
  report.usage.jevCalls++;
  report.usage.jevInputTokens += decision.inputTokens;
  report.usage.costUsd += decision.cost ?? 0;
  // A finished page, step or blocked page is acted on whatever the next pick would have been.
  if (decision.done >= gates.doneAt || decision.blocked >= gates.blockedAt || (decision.stepDone ?? 0) >= gates.stepDoneAt) return decision;
  if (decision.confidence >= gates.actAt || !o.advisor) return decision;
  const advised = await o.advisor
    .decide(step ? `${step} (one step of: ${o.goal})` : o.goal, observation, history, o.policy.offer(observation, justToggled))
    // An Advisor answer that names nothing on offer is discarded; Jev's pick stands.
    .catch((e: unknown) => { if (e instanceof ModelError) return undefined; throw e; });
  if (!advised) return { ...decision, confidence: Math.max(decision.confidence, gates.actAt) };
  report.decisions.push(record(advised));
  report.usage.advisorCalls++;
  report.usage.costUsd += advised.cost ?? 0;
  // Jev's done/blocked readings are calibrated; keep them unless the advisor is sure.
  return {
    ...advised,
    done: Math.max(advised.done, decision.done),
    blocked: Math.max(advised.blocked, decision.blocked),
    ...(decision.stepDone !== undefined ? { stepDone: decision.stepDone } : {}),
  };
}

function toAction(d: Decision, text: string | undefined): Action {
  const element = () => {
    if (!d.element) throw new ReflexError(`${d.operation} was decided without a target`);
    return d.element;
  };
  switch (d.operation) {
    case "CLICK": return { kind: "click", element: element() };
    case "TYPE":
      if (text === undefined) throw new ReflexError("TYPE was decided without text to type");
      return { kind: "type", element: element(), text };
    case "SELECT":
      if (!d.option) throw new ReflexError("SELECT was decided without an option");
      return { kind: "select", element: element(), value: d.option.value };
    case "PRESS_ENTER": return { kind: "press", key: "Enter" };
    case "SCROLL_DOWN": return { kind: "scroll", direction: "down" };
    case "SCROLL_UP": return { kind: "scroll", direction: "up" };
    case "WAIT": return { kind: "wait" };
  }
}

/** What the action visibly changed on its own target, e.g. ` → checked true→false`. */
function changeOf(action: Action, after: Observation): string {
  if (!("element" in action)) return "";
  const before = action.element;
  const now = after.elements.find((e) => e.node === before.node);
  if (!now) return " → the control is gone";
  const parts: string[] = [];
  for (const k of ["checked", "selected", "expanded", "value"] as const) {
    if (before[k] !== now[k]) parts.push(`${k} ${before[k] ?? "∅"}→${now[k] ?? "∅"}`);
  }
  return parts.length ? ` → ${parts.join(", ")}` : "";
}

function describeAction(d: Decision, text: string | undefined): string {
  const target = d.element ? ` ${d.element.id} "${d.element.name}"` : "";
  const option = d.option ? ` → "${d.option.label}"` : "";
  const typed = text !== undefined ? ` = "${text}"` : "";
  return `${d.operation}${target}${option}${typed}`;
}

function record(d: Decision): DecisionRecord {
  const top = (p: Record<string, number>) =>
    Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, round(v)] as [string, number]);
  return {
    source: d.source,
    operation: d.operation,
    ...(d.element ? { target: `${d.element.id} ${d.element.name}` } : {}),
    confidence: round(d.confidence),
    done: round(d.done),
    blocked: round(d.blocked),
    operations: top(d.operationProbabilities),
    ...(d.targetProbabilities ? { targets: top(d.targetProbabilities) } : {}),
    latencyMs: d.latencyMs,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
