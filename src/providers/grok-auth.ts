import fs from "fs";
import path from "path";

// x.ai OIDC token 端点（well-known 实测:refresh_token grant 受支持,expires_in=21600,
// refresh_token 每次轮换——所以必须回写且单飞防并发竞态）
const DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
// 提前续期窗口:剩余寿命低于此值即触发预防式续期
const REFRESH_SKEW_MS = 10 * 60 * 1000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface GrokAuthSnapshot {
  available: boolean;
  authMode: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
  expired: boolean;
  issuer: string | null;
  clientId: string | null;
  entryKey: string;
  path: string;
  mtimeMs: number;
}

export class GrokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokAuthError";
  }
}

export function resolveGrokAuthFile(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(process.env.HOME || "/root", filePath.slice(1));
  }
  return path.resolve(filePath);
}

export function resolveDefaultGrokAuthFile(): string {
  return resolveGrokAuthFile("~/.grok/auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeExpiresAt(value: unknown): { expiresAt: string | null; expired: boolean } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return {
      expiresAt: new Date(ms).toISOString(),
      expired: ms <= Date.now(),
    };
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return {
        expiresAt: new Date(parsed).toISOString(),
        expired: parsed <= Date.now(),
      };
    }
  }

  return { expiresAt: null, expired: false };
}

function findAuthEntry(parsed: unknown): { entryKey: string; entry: Record<string, unknown> } | null {
  if (!isRecord(parsed)) {
    return null;
  }

  if (typeof parsed.key === "string" && parsed.key.trim()) {
    return { entryKey: "root", entry: parsed };
  }

  const entries = Object.entries(parsed).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
  );
  const preferred = entries.find(([key, value]) => key.startsWith("https://auth.x.ai::") && typeof value.key === "string");
  const fallback = entries.find(([, value]) => typeof value.key === "string");
  const selected = preferred || fallback;
  if (!selected || !isRecord(selected[1])) {
    return null;
  }

  return {
    entryKey: selected[0],
    entry: selected[1],
  };
}

export class GrokAuthStore {
  private readonly authFilePaths: string[];
  private readonly tokenEndpoint: string;
  private cachedAuthFilePath: string | null = null;
  private cachedMtimeMs: number | null = null;
  private cachedSnapshot: GrokAuthSnapshot | null = null;
  private refreshInFlight: Promise<GrokAuthSnapshot | null> | null = null;

  constructor(authFilePath: string, fallbackAuthFilePath?: string, tokenEndpoint?: string) {
    this.authFilePaths = Array.from(
      new Set(
        [authFilePath, fallbackAuthFilePath]
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
          .map((candidate) => resolveGrokAuthFile(candidate))
      )
    );
    this.tokenEndpoint = tokenEndpoint || DEFAULT_TOKEN_ENDPOINT;
  }

  load(): GrokAuthSnapshot {
    for (const authFilePath of this.authFilePaths) {
      if (!fs.existsSync(authFilePath)) {
        continue;
      }

      const stat = fs.statSync(authFilePath);
      if (
        this.cachedSnapshot &&
        this.cachedAuthFilePath === authFilePath &&
        this.cachedMtimeMs === stat.mtimeMs
      ) {
        return this.cachedSnapshot;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(authFilePath, "utf-8"));
      } catch (err: any) {
        throw new GrokAuthError(`Failed to parse Grok auth file ${authFilePath}: ${err.message}`);
      }

      const found = findAuthEntry(parsed);
      const accessToken = found?.entry.key;
      if (!found || typeof accessToken !== "string" || !accessToken.trim()) {
        throw new GrokAuthError(`Grok auth file missing OAuth access token: ${authFilePath}`);
      }

      const expires = normalizeExpiresAt(found.entry.expires_at);
      const snapshot: GrokAuthSnapshot = {
        available: true,
        authMode: typeof found.entry.auth_mode === "string" ? found.entry.auth_mode : "unknown",
        accessToken,
        refreshToken: typeof found.entry.refresh_token === "string" ? found.entry.refresh_token : "",
        expiresAt: expires.expiresAt,
        expired: expires.expired,
        issuer: typeof found.entry.oidc_issuer === "string" ? found.entry.oidc_issuer : null,
        clientId: typeof found.entry.oidc_client_id === "string" ? found.entry.oidc_client_id : null,
        entryKey: found.entryKey,
        path: authFilePath,
        mtimeMs: stat.mtimeMs,
      };

      this.cachedAuthFilePath = authFilePath;
      this.cachedMtimeMs = stat.mtimeMs;
      this.cachedSnapshot = snapshot;
      return snapshot;
    }

    throw new GrokAuthError(`Grok auth file not found: ${this.authFilePaths.join(", ")}`);
  }

  invalidate(): void {
    this.cachedAuthFilePath = null;
    this.cachedMtimeMs = null;
    this.cachedSnapshot = null;
  }

  reloadAfterAuthFailure(previous: GrokAuthSnapshot): GrokAuthSnapshot | null {
    this.invalidate();

    let next: GrokAuthSnapshot;
    try {
      next = this.load();
    } catch {
      return null;
    }

    if (
      next.path !== previous.path ||
      next.mtimeMs !== previous.mtimeMs ||
      next.accessToken !== previous.accessToken
    ) {
      return next;
    }

    return null;
  }

  /** 是否应续期:已过期,或剩余寿命进入提前窗口。无 refresh_token/client_id 时无法续。 */
  needsRefresh(snapshot: GrokAuthSnapshot): boolean {
    if (!snapshot.refreshToken || !snapshot.clientId) {
      return false;
    }
    if (snapshot.expired) {
      return true;
    }
    if (!snapshot.expiresAt) {
      return false;
    }
    const remaining = Date.parse(snapshot.expiresAt) - Date.now();
    return Number.isFinite(remaining) && remaining <= REFRESH_SKEW_MS;
  }

  /**
   * 用 refresh_token grant 自续期,成功后原子回写 auth 文件(与 grok CLI 共用同一文件)。
   * 单飞:并发请求共享同一次续期。失败返回 null(调用方按原 token 继续或走既有错误路径)。
   */
  refresh(previous: GrokAuthSnapshot): Promise<GrokAuthSnapshot | null> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh(previous).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(previous: GrokAuthSnapshot): Promise<GrokAuthSnapshot | null> {
    // 先重读文件:grok CLI 可能刚续过(refresh_token 是轮换的,拿旧 token 去续会失败且浪费一次)
    this.invalidate();
    let current: GrokAuthSnapshot;
    try {
      current = this.load();
    } catch {
      return null;
    }
    if (current.accessToken !== previous.accessToken && !this.needsRefresh(current)) {
      return current;
    }
    if (!current.refreshToken || !current.clientId) {
      return null;
    }

    let token: TokenResponse;
    try {
      const response = await fetch(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: current.clientId,
        }),
        // 有界超时:auth.x.ai 卡死时放弃续期,回退用现有 token(预防式续期时它还没真过期)
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return null;
      }
      token = (await response.json()) as TokenResponse;
    } catch {
      return null;
    }
    if (!token.access_token) {
      return null;
    }

    try {
      this.persistRefreshedToken(current, token);
    } catch {
      return null;
    }

    this.invalidate();
    try {
      return this.load();
    } catch {
      return null;
    }
  }

  /** 把新 token 写回 auth 文件里 current 对应的 entry;原子写(tmp+rename),保 0600。 */
  private persistRefreshedToken(current: GrokAuthSnapshot, token: TokenResponse): void {
    const raw = JSON.parse(fs.readFileSync(current.path, "utf-8")) as Record<string, unknown>;
    const entry = current.entryKey === "root" ? raw : raw[current.entryKey];
    if (!isRecord(entry)) {
      throw new GrokAuthError(`Grok auth entry disappeared during refresh: ${current.entryKey}`);
    }
    entry.key = token.access_token;
    if (token.refresh_token) {
      entry.refresh_token = token.refresh_token;
    }
    if (typeof token.expires_in === "number" && Number.isFinite(token.expires_in)) {
      entry.expires_at = new Date(Date.now() + token.expires_in * 1000).toISOString();
    }
    const tmpPath = `${current.path}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(raw), { mode: 0o600 });
    fs.renameSync(tmpPath, current.path);
  }
}
