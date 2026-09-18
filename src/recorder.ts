// Records a browser page or a desktop as a video, overlay included, for showcases
// and traces. Browser frames come from CDP's screencast (the browser pushes a JPEG
// when something repaints); each keeps its arrival time, so the video plays back at
// real speed even though frames arrive irregularly. ffmpeg stitches them.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Cdp } from "./cdp.ts";
import type { DesktopSurface } from "./desktop.ts";
import type { OverlayState } from "./page/overlay.ts";

export interface RecorderOptions {
  /** Directory for frames and the finished video. */
  dir: string;
  /** JPEG quality, 1–100. Default 70. */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export class BrowserRecorder {
  private readonly cdp: Cdp;
  private readonly o: RecorderOptions;
  private readonly frames: { at: number; file: string }[] = [];
  private stopListening: (() => void) | undefined;
  private started = 0;

  constructor(cdp: Cdp, o: RecorderOptions) {
    this.cdp = cdp;
    // ffmpeg's concat list resolves relative paths against the list file, so keep everything absolute.
    this.o = { ...o, dir: resolve(o.dir) };
    mkdirSync(join(this.o.dir, "frames"), { recursive: true });
  }

  async start(): Promise<void> {
    this.started = performance.now();
    this.stopListening = this.cdp.on("Page.screencastFrame", (p) => {
      const file = join(this.o.dir, "frames", `${String(this.frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(String(p.data), "base64"));
      this.frames.push({ at: performance.now() - this.started, file });
      void this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg", quality: this.o.quality ?? 70,
      maxWidth: this.o.maxWidth ?? 1280, maxHeight: this.o.maxHeight ?? 800, everyNthFrame: 1,
    });
  }

  /** Stop and write `video.mp4`. Returns its path, or undefined when nothing was captured. */
  async stop(): Promise<string | undefined> {
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    this.stopListening?.();
    if (this.frames.length === 0) return undefined;
    const end = performance.now() - this.started;
    const lines = this.frames.map((f, i) => {
      const next = this.frames[i + 1]?.at ?? end;
      return `file '${f.file}'\nduration ${Math.max((next - f.at) / 1000, 0.01).toFixed(3)}`;
    });
    // The concat demuxer needs the last file repeated to honour its duration.
    lines.push(`file '${this.frames.at(-1)!.file}'`);
    const list = join(this.o.dir, "frames.txt");
    writeFileSync(list, lines.join("\n"));
    const out = join(this.o.dir, "video.mp4");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", out]);
    return out;
  }
}

/**
 * Records a Solari desktop as a video, with the agent's overlay burned in. The desktop has
 * no page to draw into, so the screen is recorded inside the desktop (ffmpeg x11grab, through
 * reflexd), and every `mark()` is kept with its time. On `stop()` each mark is rendered as a
 * transparent PNG (SVG through `rsvg-convert`, or ImageMagick's `magick`), and ffmpeg lays
 * them over the recording, each shown until the next.
 */
export class DesktopRecorder {
  private readonly surface: DesktopSurface;
  private readonly o: RecorderOptions & { fps?: number };
  private readonly marks: { at: number; state: OverlayState }[] = [];
  private screen: { width: number; height: number; startedAt: number } | undefined;

  constructor(surface: DesktopSurface, o: RecorderOptions & { fps?: number }) {
    this.surface = surface;
    this.o = { ...o, dir: resolve(o.dir) };
    mkdirSync(join(this.o.dir, "overlay"), { recursive: true });
  }

  async start(): Promise<void> {
    this.screen = await this.surface.startRecording({ fps: this.o.fps ?? 15 });
  }

  /** Show `state` from now until the next mark. Rects are in screen pixels. */
  mark(state: OverlayState): void {
    if (this.screen) this.marks.push({ at: performance.now() - this.screen.startedAt, state });
  }

  /** Stop, download the recording and write `video.mp4` with the overlay. Returns its path. */
  async stop(): Promise<string> {
    if (!this.screen) throw new Error("DesktopRecorder.stop() before start()");
    const end = performance.now() - this.screen.startedAt;
    const raw = join(this.o.dir, "screen.mp4");
    writeFileSync(raw, await this.surface.stopRecording());
    const { width, height } = this.screen;
    const empty = join(this.o.dir, "overlay", "empty.png");
    await svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`, empty);
    const frames: { at: number; file: string }[] = [{ at: 0, file: empty }];
    for (const [i, m] of this.marks.entries()) {
      const file = join(this.o.dir, "overlay", `${String(i).padStart(5, "0")}.png`);
      await svgToPng(overlaySvg(m.state, width, height), file);
      frames.push({ at: Math.max(m.at, 0), file });
    }
    const lines = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(((frames[i + 1]?.at ?? end) - f.at) / 1000, 0.01).toFixed(3)}`);
    lines.push(`file '${frames.at(-1)!.file}'`);
    const list = join(this.o.dir, "overlay.txt");
    writeFileSync(list, lines.join("\n"));
    const out = join(this.o.dir, "video.mp4");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-f", "concat", "-safe", "0", "-i", list,
      "-filter_complex", "[1:v]format=rgba[o];[0:v][o]overlay=0:0:eof_action=repeat,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart", out]);
    return out;
  }
}

/** The overlay as SVG, drawn the way the in-page overlay draws it. */
export function overlaySvg(state: OverlayState, width: number, height: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const font = "Menlo, DejaVu Sans Mono, monospace";
  const alt = new Set((state.alternatives ?? []).map(([id]) => id));
  const pick = state.source === "advisor" ? "#a78bfa" : "#f59e0b";
  const parts: string[] = [];
  const tag = (x: number, y: number, text: string, size: number, fill: string) => {
    const w = Math.ceil(text.length * size * 0.62) + 8;
    const h = size + 5;
    parts.push(`<rect x="${x}" y="${y - h}" width="${w}" height="${h}" rx="3" fill="${fill}"/>`,
      `<text x="${x + 4}" y="${y - 4}" font-family="${font}" font-size="${size}" font-weight="600" fill="#0b1220">${esc(text)}</text>`);
  };
  // Draw the chosen box last so nothing covers it.
  const boxes = [...state.boxes].sort((a, b) => Number(a.id === state.chosen?.id) - Number(b.id === state.chosen?.id));
  for (const b of boxes) {
    const w = Math.max(b.rect.w, 6);
    const h = Math.max(b.rect.h, 6);
    if (b.id === state.chosen?.id) {
      parts.push(`<rect x="${b.rect.x - 4}" y="${b.rect.y - 4}" width="${w + 8}" height="${h + 8}" rx="6" fill="none" stroke="${pick}" stroke-opacity=".3" stroke-width="6"/>`,
        `<rect x="${b.rect.x}" y="${b.rect.y}" width="${w}" height="${h}" rx="3" fill="none" stroke="${pick}" stroke-width="3"/>`);
      tag(b.rect.x, b.rect.y - 1, `${b.id} ${state.chosen.operation} ${Math.round(state.chosen.confidence * 100)}%`, 12, pick);
    } else if (alt.has(b.id)) {
      parts.push(`<rect x="${b.rect.x}" y="${b.rect.y}" width="${w}" height="${h}" rx="3" fill="none" stroke="#f59e0b" stroke-opacity=".7" stroke-width="2" stroke-dasharray="5 3"/>`);
      tag(b.rect.x, b.rect.y, b.id, 10, "rgba(245,158,11,.85)");
    } else {
      parts.push(`<rect x="${b.rect.x}" y="${b.rect.y}" width="${w}" height="${h}" rx="3" fill="none" stroke="rgb(56,189,248)" stroke-opacity=".55"/>`);
      tag(b.rect.x, b.rect.y, b.id, 10, "rgba(56,189,248,.85)");
    }
  }
  if (state.hud) {
    const lines = [state.hud, ...(state.alternatives?.length ? [state.alternatives.map(([id, v]) => `${id} ${(v * 100).toFixed(0)}%`).join("  ·  ")] : [])];
    const w = Math.min(Math.ceil(Math.max(...lines.map((l) => l.length)) * 13 * 0.62) + 20, width - 24);
    const h = lines.length * 19 + 12;
    parts.push(`<rect x="12" y="${height - 12 - h}" width="${w}" height="${h}" rx="8" fill="rgba(2,6,23,.85)" stroke="${pick}" stroke-opacity=".6"/>`);
    lines.forEach((l, i) => parts.push(`<text x="22" y="${height - 12 - h + 22 + i * 19}" font-family="${font}" font-size="13" font-weight="${i ? 500 : 600}" fill="${i ? "#fcd34d" : "#f8fafc"}">${esc(l)}</text>`));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

async function svgToPng(svg: string, out: string): Promise<void> {
  const src = out.replace(/\.png$/, ".svg");
  writeFileSync(src, svg);
  try {
    await run("rsvg-convert", ["-o", out, src]);
  } catch {
    await run("magick", ["-background", "none", src, out]);
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`))));
  });
}
