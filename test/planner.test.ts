import assert from "node:assert/strict";
import { test } from "node:test";
import { Planner, valuesIn } from "../src/models.ts";

test("the values a goal spells out are found", () => {
  assert.deepEqual(valuesIn('Set the quantity to 3. Apply the promotion code SOLARI20. Pay by card: email linus+mc@example.com, card number 5555 5555 5555 4444.'),
    ["linus+mc@example.com", "3", "5555 5555 5555 4444", "SOLARI20"]);
});

test("a plan that lists controls instead of actions is asked for again", async () => {
  const replies = [
    { steps: [{ target: "Quantity dropdown or input" }, { target: "Pay button" }] },
    { steps: ["Set the quantity to 3", "Click Pay"], finish: "The payment succeeded" },
  ];
  const asked: unknown[] = [];
  class Scripted extends Planner {
    protected override async complete(_system: string, user: unknown) {
      asked.push(user);
      return { json: replies.shift()! as Record<string, unknown>, latencyMs: 1, cost: 0.001 };
    }
  }
  const plan = await new Scripted({ apiKey: "k", model: "m" }).plan("Set the quantity to 3, then pay.");
  assert.deepEqual(plan.steps, ["Set the quantity to 3", "Click Pay"]);
  assert.equal(plan.finish, "The payment succeeded");
  assert.deepEqual((asked[1] as { previousPlanMissed: string[] }).previousPlanMissed, ["3"]);
});
