# solari-reflex

A speed layer for computer use on [Solari](https://getsolari.com), for browsers and desktops. Give it a goal and a Solari browser or desktop. Each step is one structured observation, one decision from [Jev](https://docs.typesafe.ai), and one verified action, with no screenshots in the loop.

```
[visa-2-lamps-promo]  18.4s jev     0.78 TYPE e2 "Add promotion code" = "SOLARI20" → value ∅→SOLARI20
[visa-2-lamps-promo]  21.2s jev     0.98 CLICK e3 "Apply" → the control is gone
[visa-2-lamps-promo]  23.6s jev     0.98 TYPE e3 "Email" = "ada+visa@example.com" → value ∅→ada+visa@example.com
[visa-2-lamps-promo]  25.7s jev     0.82 CLICK e4 "Card" → checked false→true
[visa-2-lamps-promo]  30.0s jev     1.00 TYPE e5 "Card number" = "4242 4242 4242 4242" → value ∅→4242 4242 4242 4242
```

Measured against the Codex CLI (GPT-6 Astra) driving the same Solari machines through Solari's MCP server. Each run was checked by the app it worked in. Details and videos are in [solari-fast-showcase](https://github.com/hitakshiA/solari-fast-showcase).

| Task | solari-reflex + Jev | Codex + Solari's MCP |
|---|---|---|
| Stripe Checkout (quantity 2, promotion code, card), verified by Stripe's API | **60.2 s**, $0.011 | 194.9 s, 34 tool calls |
| Six different Stripe checkouts | **66 s**, one Jev agent per browser, $0.064 | 460 s as one Codex job, 86 tool calls |
| 30 expenses categorised in LibreOffice Calc on a Solari desktop, checked against an answer key | **24.2 s**, $0.0008 | 98.4 s, 77 tool calls |

```bash
npm install --allow-git=all github:hitakshiA/solari-reflex
```

npm 12 fetches git dependencies only when allowed. Older npm, pnpm and bun don't need the flag. The package builds itself from source when npm fetches it. Tested on npm 12.0.2, where npm may warn that a `prepare` script was blocked; the package still installs and imports.

## Example: a browser

```ts
import { Advisor, BrowserPage, JevClient, Planner, Policy, Solari, TextWriter, runTask } from "solari-reflex"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const key = process.env.OPENROUTER_API_KEY!

const session = await solari.createBrowser({ stealth: true })
try {
  const page = await BrowserPage.connect(session.cdpEndpoint)
  await page.navigate("https://en.wikipedia.org")
  const report = await runTask({
    page,
    goal: "Open the Wikipedia article about Gödel's incompleteness theorems.",
    policy: new Policy(new JevClient({ apiKey: key }), { deny: ["Delete", "Pay now"] }),
    writer: new TextWriter({ apiKey: key, model: "inception/mercury-2.5" }),
    advisor: new Advisor({ apiKey: key, model: "google/gemini-3.5-flash", reasoning: "minimal" }),
    planner: new Planner({ apiKey: key, model: "google/gemini-3.5-flash", reasoning: "minimal" }),
  })
  console.log(report.status, report.timings, report.usage)
} finally {
  await solari.releaseBrowser(session.sessionId)
}
```

## Example: a desktop

`DesktopSurface` implements the same `Surface` as `BrowserPage`, so `runTask` drives desktop apps unchanged. You can also call `observe` and `act` yourself:

```ts
import { DesktopSurface, Solari } from "solari-reflex"

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
const desk = await solari.createDesktop()
const surface = await DesktopSurface.attach({ solari, sandboxId: desk.sandboxId })
let o = await surface.launch("soffice", ["--calc", "/home/desktop/work/expenses.ods"])
// o.text has the sheet's visible rows ("Row 2: A=2026-09-01 | B=Delta Air Lines | …");
// o.elements has the controls and the empty cells, named by address ("E2").
const cell = o.elements.find((e) => e.role === "gridcell" && e.name === "E2")!
await surface.act({ kind: "type", element: cell, text: "Travel" }, o)
```

`attach` installs **reflexd** into the desktop through `exec`: a small Python daemon, [src/desktop/reflexd.py](src/desktop/reflexd.py). It reads the Linux accessibility tree (AT-SPI) of the active window and acts through accessibility actions, with xdotool as the fallback. It is reached through the sandbox's preview URL, so one step is one HTTP round trip. Desktop observations have the same shape as browser ones: numbered controls, guards, visible text and a page key.

- **Spreadsheets.** Calc reports 2³¹ cells, so the grid is never walked. reflexd reads the used, visible area as text rows. It offers each empty cell under a header as an editable control named by its address.
- **Guards.** Every action is refused if the target changed after it was observed, as on the browser.
- **Typing into a cell.** reflexd focuses the cell through the accessibility API, then types and commits with Enter. Calc reports cell positions about 25 px above where it draws them, so clicking there would hit the wrong row.

## Recording, with the overlay

Every decision can be drawn over the screen: numbered boxes for the controls Jev was offered, its pick in amber with the confidence, the runners-up dashed, and a status bar with the probabilities.

- **Browser.** `page.showOverlay(overlayFor(observation, decision, hud))` draws into the page, in a closed shadow root that never takes input and that the observer never reads. It is styled with a constructed stylesheet, so it also renders on pages whose Content-Security-Policy blocks inline styles (Stripe Checkout). `BrowserRecorder` records it from CDP's screencast.
- **Desktop.** `DesktopRecorder` records the screen inside the desktop (ffmpeg x11grab, through reflexd, installed on first use). It keeps each `mark(overlayState)` with its time. On `stop()` it renders the marks as PNGs and burns them into `video.mp4` with ffmpeg. This needs ffmpeg and `rsvg-convert` (or ImageMagick) on the machine running it.

```ts
const recorder = new DesktopRecorder(surface, { dir: "runs/calc" })
await recorder.start()
recorder.mark({ boxes, chosen: { id: "E7", operation: "← Hardware", confidence: 0.99 }, hud: "E7 ← Hardware · 7.4 s" })
const video = await recorder.stop()
```

## How a step works

| Phase | What happens | Cost |
|---|---|---|
| Observe | Browser: one `Runtime.evaluate` reads the visible controls, their values and state, the visible text, a page key and a guard for each control, including inside open shadow roots (web components, Salesforce Lightning). Desktop: one reflexd request reads the same from the accessibility tree | One round trip |
| Decide | One Jev request asks which operation to run, which target to use under every operation (speculatively, in the same request), and whether the goal is done or blocked | About 400 ms, about $0.0001 |
| Write | Only for TYPE: a small model writes the value as strict JSON | About 600 ms |
| Act | Checks the target's guard, reads its current position, refuses a control that has been covered, then sends the input events pipelined | One or two round trips |
| Settle | Two animation frames, a suggestion list appearing, or the new document's `DOMContentLoaded`, driven by browser events rather than sleeps | Only as long as the page needs |

Confidence decides who acts:
- **At 0.6 or above,** Jev's pick runs.
- **Below 0.6,** the Advisor decides, choosing from the same offer Jev saw. Without an Advisor, the task hands back with `needs_help`.

With a `Planner`, the goal becomes an ordered checklist once, plus a finish condition. Jev works through the checklist one step at a time, and the same Jev request says whether the current step is already done. On top of that, `runTask` applies these rules, each added after a real run failed without it:

- **A step is ticked off without asking any model** when an action plainly carries it out: a click on the control the step names, or typing the text the step contains.
- **A checkbox or radio clicked on one step is not offered for clicking on the next,** so a toggle is never undone by a second click.
- **The history tells Jev what each action changed** ("checked false→true", "value ∅→4242…").
- **Three waits in a row reopen the previous step,** once. For example, a Pay click that only raised a validation error.
- **The task is marked blocked** after three actions that change nothing, or six that alternate between the same two.

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
| `BrowserConnectionError` | The DevTools connection closed or timed out, or reflexd could not be started or reached |

## Credits

This builds on MIT-licensed work by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [trycua/cua](https://github.com/trycua/cua), [vlad-terin/jev-use](https://github.com/vlad-terin/jev-use) and [awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use). See [NOTICE](NOTICE).

MIT licensed.
