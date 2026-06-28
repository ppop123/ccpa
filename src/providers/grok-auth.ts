import fs from "fs";
import path from "path";

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
  private cachedAuthFilePath: string | null = null;
  private cachedMtimeMs: number | null = null;
  private cachedSnapshot: GrokAuthSnapshot | null = null;

  constructor(authFilePath: string, fallbackAuthFilePath?: string) {
    this.authFilePaths = Array.from(
      new Set(
        [authFilePath, fallbackAuthFilePath]
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
          .map((candidate) => resolveGrokAuthFile(candidate))
      )
    );
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
}
