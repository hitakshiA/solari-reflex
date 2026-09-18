// The Solari control-plane calls the speed layer needs. Browsers use the same
// wire contract as @solarisdk/browser (`POST /sessions`, `DELETE /sessions/:id`)
// without its loopback proxy: the CDP endpoint is used exactly as issued.
// Desktops use the unified sandbox routes (`POST /sandboxes` with
// `kind: "desktop"`), which honour `diskGb`; the legacy `/desktops` route does
// not, and leaves about 460 MB free on the default image.
//
// Nothing is read from the environment; pass the key explicitly.

import { SolariApiError } from "./errors.ts";

export const SOLARI_BASE_URL = "https://api.getsolari.com";

export interface SolariOptions {
  apiKey: string;
  /** Default {@link SOLARI_BASE_URL} (us-west). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CreateBrowserOptions {
  /** The stealth pool (full Chromium under Xvfb) instead of the fast pool. Off by default. */
  stealth?: boolean;
  /** Solve CAPTCHAs automatically. Requires `stealth`. */
  captcha?: boolean;
  /**
   * Managed proxy egress. Requires `stealth`. A country code (`"us"`), `"smart"`,
   * or `{ country, tier: "residential" | "static" | "mobile" }`.
   */
  proxy?: string | { country?: string; tier?: "residential" | "static" | "mobile"; session?: string };
  /** Attach a stored profile (cookies and localStorage). */
  profileId?: string;
  /** Session lifetime in ms. Default 600000. */
  timeoutMs?: number;
}

export interface BrowserSession {
  sessionId: string;
  /** Raw CDP endpoint; a signed capability, valid without headers. */
  cdpEndpoint: string;
  /** Playwright wire-protocol endpoint. */
  wsEndpoint: string;
  expiresAt: string;
  /** How long the create call took, in ms. */
  createMs: number;
}

export interface BrowserProfile {
  id: string;
  name?: string;
  /** Bumped every time the profile's signed-in state is saved. */
  version?: number;
}

export interface ProfileLogin {
  handoffId: string;
  /** Where the person signs in. */
  url: string;
  expiresAt: string;
  /** The profile's version when the login was requested; a higher one means it was saved. */
  version: number;
}

export interface CreateDesktopOptions {
  /** Image to boot. Default "default" (Ubuntu 22.04, XFCE, LibreOffice, Chrome). */
  template?: string;
  /** Boot from a snapshot (`snap_…`) instead of a template. */
  fromSnapshot?: string;
  /** e.g. "1280x800". Default "1280x800". */
  resolution?: string;
  cpu?: number;
  memMb?: number;
  /** Root disk size. Default 16; the image's own 4 GB leaves too little room to install apps. */
  diskGb?: number;
  /** Idle lifetime in ms. Default 900000. */
  timeoutMs?: number;
}

export interface DesktopSession {
  sandboxId: string;
  streamUrl?: string;
  expiresAt: string;
  createMs: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class Solari {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(o: SolariOptions) {
    this.apiKey = o.apiKey;
    this.baseUrl = (o.baseUrl ?? SOLARI_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = o.fetch ?? globalThis.fetch;
  }

  /** Rent a browser. The create is idempotent, so a retried request cannot leave a second one running. */
  async createBrowser(o: CreateBrowserOptions = {}): Promise<BrowserSession> {
    const started = performance.now();
    const body = {
      timeoutMs: o.timeoutMs ?? 600_000,
      ...(o.stealth ? { stealth: true } : {}),
      ...(o.captcha !== undefined ? { captcha: o.captcha } : {}),
      ...(o.proxy !== undefined ? { proxy: o.proxy } : {}),
      ...(o.profileId ? { profileId: o.profileId } : {}),
    };
    const session = await this.request<Omit<BrowserSession, "createMs">>("POST", "/sessions", body, crypto.randomUUID());
    return { ...session, createMs: Math.round(performance.now() - started) };
  }

  /** Give a browser back. Solari releases asynchronously; this does not wait for it. */
  async releaseBrowser(sessionId: string): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Boot a desktop. */
  async createDesktop(o: CreateDesktopOptions = {}): Promise<DesktopSession> {
    const started = performance.now();
    const body = {
      kind: "desktop",
      ...(o.fromSnapshot ? { fromSnapshot: o.fromSnapshot } : { template: o.template ?? "default" }),
      resolution: o.resolution ?? "1280x800",
      diskGb: o.diskGb ?? 16,
      timeoutMs: o.timeoutMs ?? 900_000,
      ...(o.cpu ? { cpu: o.cpu } : {}),
      ...(o.memMb ? { memMb: o.memMb } : {}),
    };
    const s = await this.request<Omit<DesktopSession, "createMs">>("POST", "/sandboxes", body, crypto.randomUUID());
    return { ...s, createMs: Math.round(performance.now() - started) };
  }

  /** Run a command in a sandbox or desktop and wait for it. Runs as root, without a shell unless you ask for one. */
  exec(sandboxId: string, cmd: string, args: string[] = [], timeoutMs = 60_000): Promise<ExecResult> {
    return this.request<ExecResult>("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { cmd, args, timeoutMs });
  }

  /** Public URL for a port inside the machine. */
  async previewUrl(sandboxId: string, port: number): Promise<string> {
    const r = await this.request<{ url: string }>("GET", `/sandboxes/${encodeURIComponent(sandboxId)}/ports/${port}`);
    return r.url;
  }

  /** Saved browser profiles: stored signed-in state (cookies and localStorage) that new browsers can start from. */
  async profiles(): Promise<BrowserProfile[]> {
    const rows = await this.request<BrowserProfile[] | { profiles?: BrowserProfile[] }>("GET", "/profiles");
    return Array.isArray(rows) ? rows : rows.profiles ?? [];
  }

  /** The profile with this name, created if there is none. */
  async ensureProfile(name: string): Promise<BrowserProfile> {
    const found = (await this.profiles()).find((p) => (p.name ?? "").toLowerCase() === name.toLowerCase());
    if (found) return found;
    return this.request<BrowserProfile>("POST", "/profiles", { name });
  }

  /**
   * Ask a person to sign in to a profile. Returns a link to a Solari-hosted browser where they
   * sign in themselves; the credentials and cookies never pass through this process or any
   * model. Wait for it with {@link waitForProfileLogin}, then start browsers with
   * `createBrowser({ profileId })`.
   */
  requestProfileLogin(profileId: string, reason: string): Promise<ProfileLogin> {
    return this.request<ProfileLogin>("POST", `/profiles/${encodeURIComponent(profileId)}/login-handoff`, { reason });
  }

  /**
   * Resolves true once the profile has been saved since `sinceVersion` (the person finished
   * signing in), false at the timeout. Polls the profile list; nothing sensitive is returned.
   */
  async waitForProfileLogin(profileId: string, sinceVersion: number, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
    const deadline = performance.now() + (o.timeoutMs ?? 300_000);
    while (performance.now() < deadline) {
      const profile = (await this.profiles()).find((p) => p.id === profileId);
      if (!profile) throw new SolariApiError(404, `profile ${profileId} no longer exists`);
      if ((profile.version ?? 0) > sinceVersion) return true;
      await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    }
    return false;
  }

  /** Delete a sandbox or desktop. */
  async deleteSandbox(sandboxId: string): Promise<void> {
    await this.request("DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const code = typeof json.code === "string" ? json.code : undefined;
      const message = typeof json.message === "string" ? json.message : text.slice(0, 200);
      throw new SolariApiError(response.status, `Solari ${method} ${path} returned ${response.status}: ${message}`, code);
    }
    return json as T;
  }
}
