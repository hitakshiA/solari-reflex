import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesOut, runTask } from "../src/agent.ts";
import type { Action, Decision, Observation, ObservedElement, Planner, Policy, Surface, TextWriter } from "../src/index.ts";

const el = (name: string, role: ObservedElement["role"] = "button"): ObservedElement => ({ id: "e1", node: 1, role, name, editable: false });

test("a typed value finishes the step that contains it", () => {
  assert.equal(carriesOut("Enter the promotion code SOLARI20", { kind: "type", element: el("Add promotion code", "textbox"), text: "SOLARI20" }), true);
  assert.equal(carriesOut("Enter the email ada@example.com", { kind: "type", element: el("Email", "textbox"), text: "SOLARI20" }), false);
});

test("a click finishes only a click-type step that names the control", () => {
  assert.equal(carriesOut("Click the Apply button", { kind: "click", element: el("Apply") }), true);
  assert.equal(carriesOut('Untick "Save my information for faster checkout"', { kind: "click", element: el("Save my information for faster checkout", "checkbox") }), true);
  // "Card" appears inside the step, but the step is about typing, not clicking.
  assert.equal(carriesOut("Enter the card number 4242 4242 4242 4242", { kind: "click", element: el("Card", "radio") }), false);
});

test("waiting that brings nothing reopens the step before it, once", async () => {
  // Checkout where the first Pay only raises a validation error; the second one pays.
  let pays = 0;
  let text = "Pay $49.00";
  const pay: ObservedElement = { id: "e1", node: 1, role: "button", name: "Pay", editable: false };
  const observe = async () => ({ url: "https://checkout.example/pay", title: "Checkout", pageKey: text, text, elements: [pay], guards: { 1: "button|Pay" } }) as unknown as Observation;
  const page = {
    observe,
    act: async (a: Action) => {
      if (a.kind === "click") text = ++pays === 1 ? "Pay $49.00 · Enter your email" : "Payment succeeded";
      return { navigated: false };
    },
  } as unknown as Surface;
  const decision = (operation: Decision["operation"], rest: Partial<Decision> = {}): Decision => ({
    source: "jev", operation, confidence: 0.9, done: 0, blocked: 0, stepDone: 0,
    operationProbabilities: { [operation]: 0.9 }, model: "fake", latencyMs: 1, inputTokens: 1, ...rest,
  });
  const policy = {
    decide: async (_goal: string, o: Observation, _h: unknown, step?: string) =>
      step === "Click Pay" ? decision("CLICK", { element: pay })
        : o.text.includes("succeeded") ? decision("WAIT", { done: 0.95 }) : decision("WAIT"),
  } as unknown as Policy;
  const planner = { plan: async () => ({ steps: ["Click Pay", "Wait for the payment result"], finish: "The page says the payment succeeded" }) } as unknown as Planner;

  const report = await runTask({ page, policy, planner, writer: {} as TextWriter, goal: "Pay", maxSteps: 12 });
  assert.equal(report.status, "done");
  assert.equal(pays, 2);
  assert.deepEqual(report.steps.map((s) => s.action.split(" ")[0]), ["CLICK", "WAIT", "WAIT", "WAIT", "CLICK"]);
});
