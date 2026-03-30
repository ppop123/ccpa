import fs from "fs";
import path from "path";

export interface CodexAuthSnapshot {
  available: boolean;
  authMode: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: string | null;
  path: string;
  mtimeMs: number;
}

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export function resolveCodexAuthFile(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(process.env.HOME || "/root", filePath.slice(1));
  }
  return path.resolve(filePath);
}

export function resolveDefaultCodexAuthFile(): string {
  return resolveCodexAuthFile("~/.codex/auth.json");
}

export class CodexAuthStore {
  private readonly authFilePaths: string[];
  private cachedAuthFilePath: string | null = null;
  private cachedMtimeMs: number | null = null;
  private cachedSnapshot: CodexAuthSnapshot | null = null;

  constructor(authFilePath: string, fallbackAuthFilePath?: string) {
    this.authFilePaths = Array.from(
      new Set(
        [authFilePath, fallbackAuthFilePath]
          .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
          .map((candidate) => resolveCodexAuthFile(candidate))
      )
    );
  }

  load(): CodexAuthSnapshot {
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

      let parsed: any;
      try {
        parsed = JSON.parse(fs.readFileSync(authFilePath, "utf-8"));
      } catch (err: any) {
        throw new CodexAuthError(
          `Failed to parse Codex auth file ${authFilePath}: ${err.message}`
        );
      }

      const accessToken = parsed?.tokens?.access_token;
      if (!accessToken) {
        throw new CodexAuthError(`Codex auth file missing tokens.access_token: ${authFilePath}`);
      }

      const snapshot: CodexAuthSnapshot = {
        available: true,
        authMode: parsed?.auth_mode || "unknown",
        accessToken,
        refreshToken: parsed?.tokens?.refresh_token || "",
        accountId: parsed?.tokens?.account_id || "",
        lastRefresh: typeof parsed?.last_refresh === "string" ? parsed.last_refresh : null,
        path: authFilePath,
        mtimeMs: stat.mtimeMs,
      };

      this.cachedAuthFilePath = authFilePath;
      this.cachedMtimeMs = stat.mtimeMs;
      this.cachedSnapshot = snapshot;
      return snapshot;
    }

    throw new CodexAuthError(`Codex auth file not found: ${this.authFilePaths.join(", ")}`);
  }
}
