// Records a browser page as a video, overlay included, for showcases and
// traces. Frames come from CDP's screencast (the browser pushes a JPEG when
// something repaints); each keeps its arrival time, so the video plays back at
// real speed even though frames arrive irregularly. ffmpeg stitches them.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Cdp } from "./cdp.ts";

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
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
        "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", out]);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return out;
  }
}
