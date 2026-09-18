import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesOut } from "../src/agent.ts";
import type { ObservedElement } from "../src/index.ts";

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
