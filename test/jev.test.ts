import assert from "node:assert/strict";
import { test } from "node:test";
import { JevClient, JevError } from "../src/index.ts";

const questions = {
  op: { type: "choice", instructions: "which?", criteria: { CLICK: null, TYPE: null } },
  done: { type: "noul", instructions: "done?" },
} as const;

function client(status: number, body: unknown): JevClient {
  const fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof globalThis.fetch;
  return new JevClient({ apiKey: "k", fetch, maxRetries: 0 });
}

const ok = {
  model: "typesafe/jev-1.13",
  answers: {
    op: { type: "choice", choice: "TYPE", probabilities: { CLICK: 0.1, TYPE: 0.9 }, confidence: 0.85 },
    done: { type: "noul", noul: 0.02 },
  },
  usage: { input_tokens: 120, cost: 0.00001 },
};

test("a valid response decodes to typed answers", async () => {
  const r = await client(200, ok).ask("state", questions);
  assert.equal(r.answers.op.choice, "TYPE");
  assert.equal(r.answers.done.noul, 0.02);
  assert.equal(r.usage.inputTokens, 120);
});

test("a choice that was not offered is malformed, never a guess", async () => {
  const bad = structuredClone(ok);
  bad.answers.op.choice = "SCROLL";
  await assert.rejects(client(200, bad).ask("state", questions), (e: JevError) => e.code === "jev_malformed_response");
});

test("probabilities must describe exactly the offered options", async () => {
  const bad = structuredClone(ok);
  bad.answers.op.probabilities = { CLICK: 0.1, TYPE: 0.9, EXTRA: 0 } as never;
  await assert.rejects(client(200, bad).ask("state", questions), (e: JevError) => e.code === "jev_malformed_response");
});

test("statuses keep their meaning", async () => {
  for (const [status, code] of [[401, "jev_unauthorized"], [402, "jev_payment_required"], [429, "jev_rate_limited"],
    [529, "jev_upstream_unavailable"], [422, "jev_rejected_request"]] as const) {
    await assert.rejects(client(status, {}).ask("s", questions), (e: JevError) => e.code === code && e.status === status);
  }
});

test("more than 255 options is refused before the network", async () => {
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`e${i}`, null]));
  let called = false;
  const fetch = (async () => { called = true; return new Response("{}"); }) as typeof globalThis.fetch;
  const c = new JevClient({ apiKey: "k", fetch });
  await assert.rejects(c.ask("s", { big: { type: "choice", instructions: "x", criteria } }), JevError);
  assert.equal(called, false);
});
