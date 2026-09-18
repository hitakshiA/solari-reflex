import assert from "node:assert/strict";
import { test } from "node:test";
import { JevClient, Policy, type Observation, type ObservedElement } from "../src/index.ts";

const el = (id: string, role: ObservedElement["role"], name: string, extra: Partial<ObservedElement> = {}): ObservedElement =>
  ({ id, node: Number(id.slice(1)), role, name, editable: false, ...extra });

const observation: Observation = {
  url: "https://shop.example/cart", title: "Cart", text: "Your cart",
  viewport: { width: 1280, height: 800 }, scroll: { y: 0, height: 2000 },
  elements: [
    el("e1", "searchbox", "Search", { editable: true }),
    el("e2", "button", "Checkout"),
    el("e3", "button", "Delete account"),
    el("e4", "select", "Quantity", { options: [{ value: "2", label: "2" }] }),
  ],
  omitted: 0, pageKey: "k", guards: {},
};

test("denied controls are absent from every head", () => {
  const offer = new Policy(new JevClient({ apiKey: "k" }), { deny: ["delete"] }).offer(observation);
  assert.ok(!offer.elements.some((e) => e.id === "e3"));
  assert.ok(!("e3" in (offer.heads.click_target ?? {})));
});

test("operations are offered only when they have a target or apply", () => {
  const offer = new Policy(new JevClient({ apiKey: "k" })).offer(observation);
  assert.deepEqual(Object.keys(offer.operations).sort(), ["CLICK", "SCROLL_DOWN", "SELECT", "TYPE", "WAIT"]);
  assert.deepEqual(Object.keys(offer.heads.type_target ?? {}), ["e1"]);
  assert.deepEqual(Object.keys(offer.heads.select_target ?? {}), ["e4:1"]);
});

test("a TYPE decision takes its target from the type head and its confidence is the minimum", async () => {
  const fetch = (async (_: unknown, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body));
    const choice = (id: string, choice: string, confidence: number) => {
      const keys = Object.keys(questions[id].criteria);
      return { type: "choice", choice, confidence, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])) };
    };
    return new Response(JSON.stringify({ model: "jev", usage: { input_tokens: 1 }, answers: {
      operation: choice("operation", "TYPE", 0.9),
      click_target: choice("click_target", "e2", 0.9),
      type_target: choice("type_target", "e1", 0.7),
      select_target: choice("select_target", "e4:1", 0.9),
      done: { type: "noul", noul: 0.1 }, blocked: { type: "noul", noul: 0.1 },
    } }));
  }) as typeof globalThis.fetch;
  const d = await new Policy(new JevClient({ apiKey: "k", fetch })).decide("find shoes", observation, []);
  assert.equal(d.operation, "TYPE");
  assert.equal(d.element?.id, "e1");
  assert.equal(d.confidence, 0.7);
});
