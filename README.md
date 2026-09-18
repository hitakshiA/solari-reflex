# solari-reflex

A speed layer for computer use on [Solari](https://getsolari.com). Give it a goal and a Solari browser; each step is one structured observation, one decision from [Jev](https://docs.typesafe.ai), and one verified action. There are no screenshots in the loop.

```
  3.1s  jev     0.85  TYPE e2 "Search Wikipedia" = "Gödel's incompleteness theorems"
  4.7s  jev     0.79  CLICK e3 "Gödel's incompleteness theorems Limitative results in mathematical logic"
status  : done   time: 5.3s   cost: $0.00048
```

On the same goal, the usual loop (a screenshot to GPT-6 Astra each step, returning pixel coordinates) took 13.2 s and cost $0.071. That's 2.7× slower and 147× more expensive. See the [agent race](https://github.com/hitakshiA/solari-cookbook/tree/main/examples/browser-agent-race-ts) in the cookbook fork.

```bash
npm install github:hitakshiA/solari-reflex
```

## Example

```ts
import { Solari } from "@solarisdk/browser"
import { Advisor, BrowserPage, JevClient, Policy, TextWriter, runTask } from "solari-reflex"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const key = process.env.OPENROUTER_API_KEY!

const session = await solari.sessions.create()
try {
  const page = await BrowserPage.connect(session.cdpEndpoint)
  await page.navigate("https://en.wikipedia.org")
  const report = await runTask({
    page,
    goal: "Open the Wikipedia article about Gödel's incompleteness theorems.",
    policy: new Policy(new JevClient({ apiKey: key }), { deny: ["Delete", "Pay now"] }),
    writer: new TextWriter({ apiKey: key, model: "inception/mercury-2.5" }),
    advisor: new Advisor({ apiKey: key, model: "google/gemini-3.5-flash", reasoning: "minimal" }),
  })
  console.log(report.status, report.timings, report.usage)
} finally {
  await solari.sessions.releaseAndWait(session.id)
}
```

## How a step works

| Phase | What happens | Cost |
|---|---|---|
| Observe | One `Runtime.evaluate` reads the visible controls, their values and state, the visible text, a page key and a guard for each control | One round trip |
| Decide | One Jev request asks which operation to run, which target to use under every operation (speculatively, in the same request), and whether the goal is done or blocked | About 400 ms, about $0.0001 |
| Write | Only for TYPE: a small model writes the value as strict JSON | About 600 ms |
| Act | Checks the target's guard, reads its current position, refuses a control that has been covered, then sends the input events pipelined | One or two round trips |
| Settle | Two animation frames, a suggestion list appearing, or the new document's `DOMContentLoaded`, driven by browser events rather than sleeps | Only as long as the page needs |

Confidence decides who acts:
- **At 0.6 or above,** Jev's pick runs.
- **Below 0.6,** the Advisor decides, choosing from the same offer Jev saw. Without an Advisor, the task hands back with `needs_help`.

With a `Planner`, the goal becomes an ordered checklist once, and Jev works through it one step at a time. Whether the current step is already done is read in the same Jev request.

## Design

- **Model output never reaches the page as code.** Every action names a control that was observed. Input goes to where that control is now, after a guard check. Nothing the model returns becomes a selector, a coordinate or script.
- **Deny lists are enforced in code.** A control whose name matches a deny term is left out of the question, and the pick is checked again afterwards. It's absent, not just disfavoured.
- **Answers are validated.** A choice that wasn't offered, or probabilities that don't describe the offer, is a `JevError` with a stable `code`. It's never treated as a best guess.
- **Failures leave the page untouched.** A `JevError` or a `StaleObservationError` means nothing was dispatched.
- **Nothing is read from the environment.** Keys are passed in explicitly.
- **Every phase is timed.** `TaskReport` splits observe, decide, write and act time for each step, and records every decision, including ones that ended the task.

## Errors

| Class | When |
|---|---|
| `JevError` | Jev gave no usable decision. The `code` is one of `jev_unauthorized`, `jev_payment_required`, `jev_rate_limited`, `jev_upstream_unavailable`, `jev_rejected_request`, `jev_unreachable` or `jev_malformed_response` |
| `StaleObservationError` | The target changed after it was observed. Nothing was dispatched |
| `ModelError` | The text writer or advisor returned something unusable |
| `SolariApiError` | A Solari control-plane call failed |
| `BrowserConnectionError` | The DevTools connection closed or timed out |

## Credits

This builds on MIT-licensed work by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [trycua/cua](https://github.com/trycua/cua), [vlad-terin/jev-use](https://github.com/vlad-terin/jev-use) and [awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use). See [NOTICE](NOTICE).

MIT licensed.
