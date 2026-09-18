// A Solari desktop driven through its accessibility tree.
//
// The stock desktop image ships with the accessibility bus off and no bindings
// installed. `DesktopSurface.attach` turns it on (about 10 s the first time),
// installs `reflexd` — a small HTTP daemon that reads the tree and acts on it —
// and starts it as the desktop user. From then on every observe or act is one
// request to reflexd:
//
//   transport "preview"  the machine's preview URL: one keep-alive connection
//                        from the client, no per-call exec;
//   transport "exec"     Solari exec running curl against localhost: works
//                        anywhere, one exec round trip per call.
//
// Observations have the same shape as the browser observer's, so the same
// Policy and runTask drive both.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { BrowserConnectionError, StaleObservationError } from "./errors.ts";
import type { Observation } from "./page/observer.ts";
import type { Solari } from "./solari.ts";
import type { ActOutcome, Action, Surface } from "./surface.ts";

// Solari's exec accepts at most 16 KB per request, so the daemon travels gzipped.
const REFLEXD_GZ = gzipSync(readFileSync(new URL("./desktop/reflexd.py", import.meta.url)), { level: 9 }).toString("base64");
const PORT = 7788;

export interface DesktopSurfaceOptions {
  solari: Solari;
  sandboxId: string;
  /** How the client reaches reflexd. Default "preview". */
  transport?: "preview" | "exec";
  /** Controls offered per observation. Default 120. */
  maxElements?: number;
  /** Visible text sent with each observation, in characters. Default 3000. */
  maxTextChars?: number;
}

interface Reply<T> { result?: T; error?: string; ms?: number }

export class DesktopSurface implements Surface {
  readonly sandboxId: string;
  private readonly solari: Solari;
  private readonly token: string;
  private readonly maxElements: number;
  private readonly maxTextChars: number;
  private baseUrl: string | undefined;

  private constructor(o: DesktopSurfaceOptions, token: string) {
    this.solari = o.solari;
    this.sandboxId = o.sandboxId;
    this.token = token;
    this.maxElements = o.maxElements ?? 120;
    this.maxTextChars = o.maxTextChars ?? 3000;
  }

  /** Enable accessibility on the desktop, install and start reflexd, and connect to it. */
  static async attach(o: DesktopSurfaceOptions): Promise<DesktopSurface> {
    const token = crypto.randomUUID().replaceAll("-", "");
    const surface = new DesktopSurface(o, token);
    const r = await o.solari.exec(o.sandboxId, "bash", ["-c", installScript(token)], 180_000);
    if (r.exitCode !== 0 || !r.stdout.includes("reflexd ready")) {
      throw new BrowserConnectionError(`reflexd did not start: ${(r.stderr || r.stdout).slice(-300)}`);
    }
    if ((o.transport ?? "preview") === "preview") {
      surface.baseUrl = await o.solari.previewUrl(o.sandboxId, PORT);
      const health = await fetch(surface.endpoint("/health")).then((x) => x.json()).catch(() => null) as { ok?: boolean } | null;
      if (!health?.ok) surface.baseUrl = undefined;
    }
    return surface;
  }

  /** Which transport is in use after attach. */
  get transport(): "preview" | "exec" {
    return this.baseUrl ? "preview" : "exec";
  }

  /**
   * Start a GUI app as the desktop user, with the accessibility bridge on, and
   * wait until its window is the one observed.
   */
  async launch(command: string, args: string[] = [], o: { waitMs?: number } = {}): Promise<Observation> {
    const quoted = [command, ...args].map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
    await this.solari.exec(this.sandboxId, "bash", ["-c", `runuser -u "$(cat /opt/reflex/user)" -- bash /opt/reflex/launch.sh ${quoted}`], 30_000);
    const deadline = performance.now() + (o.waitMs ?? 45_000);
    const name = command.split("/").pop() ?? command;
    let last: Observation | undefined;
    while (performance.now() < deadline) {
      last = await this.observe().catch(() => undefined);
      if (last && last.elements.length > 0 && appMatches(last, name)) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (last) return last;
    throw new BrowserConnectionError(`${command} did not open a window`);
  }

  async observe(): Promise<Observation> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const o = await this.call<Observation | null>("/observe", { max_elements: this.maxElements, max_text_chars: this.maxTextChars });
      if (o) return o;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new StaleObservationError("No window is active on the desktop");
  }

  async act(action: Action, observation: Observation): Promise<ActOutcome> {
    const element = "element" in action ? action.element : undefined;
    const body = {
      action: {
        kind: action.kind,
        ...(element ? { node: element.node } : {}),
        ...(action.kind === "type" ? { text: action.text, ...(action.submit ? { submit: true } : {}) } : {}),
        ...(action.kind === "select" ? { value: action.value } : {}),
        ...(action.kind === "press" ? { key: action.key } : {}),
        ...(action.kind === "scroll" ? { direction: action.direction } : {}),
      },
      guard: element ? observation.guards[element.node] ?? null : null,
    };
    const r = await this.call<{ navigated?: boolean; error?: string }>("/act", body);
    if (r.error) throw new StaleObservationError(`${element ? `${element.id} (${element.name})` : action.kind}: ${r.error}`);
    return { navigated: Boolean(r.navigated) };
  }

  async screenshot(o: { quality?: number } = {}): Promise<Uint8Array> {
    const r = await this.call<{ jpeg: string | null }>("/screenshot", { quality: o.quality ?? 70 });
    if (!r.jpeg) throw new BrowserConnectionError("The desktop screenshot failed");
    return Buffer.from(r.jpeg, "base64");
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const reply = this.baseUrl ? await this.viaPreview<T>(path, body) : await this.viaExec<T>(path, body);
    if (reply.error) throw new BrowserConnectionError(`reflexd ${path}: ${reply.error}`);
    return reply.result as T;
  }

  /**
   * Preview URLs carry their access token in the query string
   * (`https://<id>-7788.preview.getsolari.com?pt_token=…`), so the path is set on
   * the parsed URL rather than appended to the string.
   */
  private endpoint(path: string): string {
    const u = new URL(this.baseUrl!);
    u.pathname = path;
    return u.toString();
  }

  private async viaPreview<T>(path: string, body: unknown): Promise<Reply<T>> {
    const r = await fetch(this.endpoint(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return (await r.json()) as Reply<T>;
  }

  private async viaExec<T>(path: string, body: unknown): Promise<Reply<T>> {
    const r = await this.solari.exec(this.sandboxId, "curl", [
      "-s", "-X", "POST", `http://127.0.0.1:${PORT}${path}`,
      "-H", `Authorization: Bearer ${this.token}`, "-H", "Content-Type: application/json",
      "--data-binary", JSON.stringify(body),
    ], 60_000);
    try {
      return JSON.parse(r.stdout) as Reply<T>;
    } catch {
      return { error: `unreadable reply: ${(r.stdout || r.stderr).slice(0, 200)}` };
    }
  }
}

function appMatches(o: Observation, command: string): boolean {
  const app = o.url.replace("app://", "").split("/")[0]?.toLowerCase() ?? "";
  const c = command.toLowerCase();
  return app.includes(c) || c.includes(app) || (c === "soffice" && /office|calc|writer/.test(`${app} ${o.title}`.toLowerCase()));
}

/**
 * Root script, run once through exec: accessibility packages, reflexd, the bus,
 * and a launcher that starts apps with the bridge on. Idempotent.
 */
function installScript(token: string): string {
  return `set -e
export DEBIAN_FRONTEND=noninteractive
if ! python3 -c 'import gi; gi.require_version("Atspi","2.0")' 2>/dev/null; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq --no-install-recommends at-spi2-core python3-gi gir1.2-atspi-2.0 libatk-adaptor imagemagick >/dev/null 2>&1
fi
mkdir -p /opt/reflex
echo '${REFLEXD_GZ}' | base64 -d | gunzip > /opt/reflex/reflexd.py
# A fresh desktop may still be starting its session; wait for it rather than fail silently.
for i in $(seq 1 60); do P=$(pgrep -x xfce4-session | head -1 || true); [ -n "$P" ] && break; sleep 0.5; done
[ -n "$P" ] || { echo "no desktop session (xfce4-session) is running"; exit 1; }
ps -o user= -p "$P" | tr -d ' ' > /opt/reflex/user
tr '\\0' '\\n' < /proc/$P/environ | grep -E '^(DBUS_SESSION_BUS_ADDRESS|DISPLAY|XDG_RUNTIME_DIR|HOME|XAUTHORITY)=' > /opt/reflex/session.env
cat > /opt/reflex/start.sh <<'SH'
set -a; . /opt/reflex/session.env; set +a
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || true
pgrep -u "$(id -un)" -f at-spi-bus-launcher >/dev/null || setsid -f /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 </dev/null
sleep 0.5
pkill -u "$(id -un)" -f "reflex/reflexd.py" || true
REFLEXD_TOKEN="$1" setsid -f python3 /opt/reflex/reflexd.py >/opt/reflex/reflexd.log 2>&1 </dev/null
SH
cat > /opt/reflex/launch.sh <<'SH'
set -a; . /opt/reflex/session.env; set +a
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge SAL_USE_VCLPLUGIN=gtk3 GNOME_ACCESSIBILITY=1
setsid -f "$@" >/dev/null 2>&1 </dev/null
SH
chown -R "$(cat /opt/reflex/user)" /opt/reflex
runuser -u "$(cat /opt/reflex/user)" -- bash /opt/reflex/start.sh '${token}'
for i in $(seq 1 50); do curl -sf http://127.0.0.1:${PORT}/health >/dev/null && { echo "reflexd ready"; exit 0; }; sleep 0.2; done
echo "reflexd not ready"; tail -5 /opt/reflex/reflexd.log; exit 1`;
}
