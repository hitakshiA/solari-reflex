// One DevTools connection, held open for the whole task.
//
// Solari's Node browser SDK puts a loopback proxy in front of every
// WebSocket and asks for the page list on every action. Here there is one
// socket and one attached page, and commands are pipelined: each carries an
// id and answers are matched as they arrive, so independent calls cost one
// round trip together rather than one each.

import { BrowserConnectionError } from "./errors.ts";

export interface CdpOptions {
  /** How long to wait for the socket to open, in ms. Default 10000. */
  openTimeoutMs?: number;
  /** Per-command timeout in ms. Default 30000. */
  commandTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener = (params: Record<string, unknown>) => void;

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export class Cdp {
  private readonly ws: WebSocket;
  private readonly commandTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private nextId = 1;
  private pageSession: string | undefined;

  private constructor(ws: WebSocket, commandTimeoutMs: number) {
    this.ws = ws;
    this.commandTimeoutMs = commandTimeoutMs;
    // The stealth pool sends binary frames; the fast pool sends text. Accept both.
    ws.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    ws.addEventListener("message", (event) =>
      this.dispatch(typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer)));
    ws.addEventListener("close", () => this.failAll(new BrowserConnectionError("The browser connection closed")));
  }

  /**
   * Connect to a browser-level endpoint and attach to its first page, making
   * one when the browser has none yet (a freshly rented browser can answer
   * before its first tab exists).
   */
  static async connect(url: string, o: CdpOptions = {}): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BrowserConnectionError("The browser did not answer")), o.openTimeoutMs ?? 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new BrowserConnectionError("Could not reach the browser")); }, { once: true });
    });
    const cdp = new Cdp(ws, o.commandTimeoutMs ?? 30_000);
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    let targetId = targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://"))?.targetId;
    targetId ??= (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    cdp.pageSession = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    return cdp;
  }

  /** Send a command to the attached page (or to the browser, before a page is attached). */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserConnectionError("The browser connection is closed"));
    }
    const id = this.nextId++;
    const message = { id, method, params, ...(this.pageSession ? { sessionId: this.pageSession } : {}) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserConnectionError(`${method} got no answer in ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as Pending["resolve"], reject, timer });
      this.ws.send(JSON.stringify(message));
    });
  }

  /** Evaluate an expression in the page. A thrown page error resolves to `undefined`. */
  async evaluate<T>(expression: string, o: { awaitPromise?: boolean } = {}): Promise<T | undefined> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: o.awaitPromise ?? false });
    return r.exceptionDetails ? undefined : r.result?.value;
  }

  /** Subscribe to a protocol event; returns the unsubscribe function. */
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => { set.delete(listener); };
  }

  close(): void {
    this.ws.close();
  }

  private dispatch(data: string): void {
    let message: Message;
    try { message = JSON.parse(data) as Message; } catch { return; }
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error) p.reject(new BrowserConnectionError(`${p.method}: ${message.error.message}`));
      else p.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  }

  private failAll(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
}
