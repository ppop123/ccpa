import fs from "node:fs";
import path from "node:path";

import { TokenData } from "../auth/types";
import { refreshTokensWithRetry } from "../auth/oauth";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { redactForLog } from "../logging/redact";

const REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours before expiry
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s
const ACCOUNT_STATE_FILENAME = "state.json";
const TOKEN_EXPIRY_SKEW_MS = 30 * 1000;

// Refresh-failure backoff: when refresh keeps failing (e.g. refresh_token
// invalidated, oauth endpoint rate-limited), don't hammer Anthropic every 60s.
// Failure 1→60s, 2→2min, 3→4min, ... capped at 30min.
const REFRESH_FAIL_BASE_MS = 60 * 1000;
const REFRESH_FAIL_MAX_MS = 30 * 60 * 1000;

export type AccountFailureKind = "rate_limit" | "auth" | "forbidden" | "server" | "network";

const FAILURE_BACKOFF: Record<AccountFailureKind, { baseMs: number; maxMs: number }> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

interface PersistedAccountRuntimeState {
  cooldownUntil?: unknown;
  failureCount?: unknown;
  lastError?: unknown;
  lastFailureAt?: unknown;
  lastSuccessAt?: unknown;
  lastRefreshAt?: unknown;
  totalRequests?: unknown;
  totalSuccesses?: unknown;
  totalFailures?: unknown;
  refreshFailureCount?: unknown;
  nextRefreshAttemptAt?: unknown;
}

interface PersistedAccountStateFile {
  version: 1;
  accounts: Record<string, PersistedAccountRuntimeState>;
}

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  refreshing: boolean;
  refreshPromise: Promise<boolean> | null;
  // Refresh backoff: how many consecutive refresh failures, and the next
  // time we're allowed to attempt one. Reset on any refresh success.
  refreshFailureCount: number;
  nextRefreshAttemptAt: number;
}

export interface AccountSnapshot {
  email: string;
  available: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  expiresAt: string;
  refreshing: boolean;
  refreshFailureCount: number;
  nextRefreshAttemptAt: number;
}

export type AccountAvailability =
  | { state: "missing" }
  | { state: "available"; email: string }
  | {
      state: "expired";
      email: string;
      expiresAt: string;
      refreshFailureCount: number;
      nextRefreshAttemptAt: number;
    }
  | { state: "cooldown"; email: string; cooldownUntil: number; lastError: string | null };

export class AccountManager {
  private account: AccountState | null = null;
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir);
    if (tokens.length > 1) {
      throw new Error(
        `Single-account mode only supports one token in ${this.authDir}; found ${tokens.length}.`
      );
    }

    const persisted = this.loadPersistedStates();
    this.account = tokens[0] ? this.createAccountState(tokens[0]) : null;
    if (this.account) {
      this.applyPersistedState(this.account, persisted[this.account.token.email]);
    }
    console.log(`Loaded ${this.account ? 1 : 0} account(s)`);
  }

  addAccount(token: TokenData): void {
    if (this.account && this.account.token.email !== token.email) {
      throw new Error(
        `Single-account mode already has ${redactForLog(this.account.token.email)}. ` +
          `Remove the existing token before logging into ${redactForLog(token.email)}.`
      );
    }

    if (this.account) {
      this.account.token = token;
      this.account.cooldownUntil = 0;
      this.account.failureCount = 0;
      this.account.lastError = null;
      this.account.lastFailureAt = null;
      this.account.lastSuccessAt = new Date().toISOString();
      this.account.lastRefreshAt = new Date().toISOString();
      this.account.refreshFailureCount = 0;
      this.account.nextRefreshAttemptAt = 0;
    } else {
      this.account = this.createAccountState(token);
      this.account.lastSuccessAt = new Date().toISOString();
      this.account.lastRefreshAt = new Date().toISOString();
    }

    saveToken(this.authDir, token);
    this.persistState();
  }

  getNextAccount(): TokenData | null {
    if (!this.account) return null;
    return isAccountUsable(this.account) ? this.account.token : null;
  }

  getAvailability(): AccountAvailability {
    if (!this.account) {
      return { state: "missing" };
    }

    if (isTokenExpired(this.account.token)) {
      return {
        state: "expired",
        email: this.account.token.email,
        expiresAt: this.account.token.expiresAt,
        refreshFailureCount: this.account.refreshFailureCount,
        nextRefreshAttemptAt: this.account.nextRefreshAttemptAt,
      };
    }

    if (this.account.cooldownUntil > Date.now()) {
      return {
        state: "cooldown",
        email: this.account.token.email,
        cooldownUntil: this.account.cooldownUntil,
        lastError: this.account.lastError,
      };
    }

    return { state: "available", email: this.account.token.email };
  }

  recordAttempt(email: string): void {
    const acct = this.getAccountByEmail(email);
    if (acct) {
      acct.totalRequests++;
      this.persistState();
    }
  }

  recordSuccess(email: string): void {
    const acct = this.getAccountByEmail(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;
    this.persistState();
  }

  recordFailure(email: string, kind: AccountFailureKind, detail?: string): void {
    const acct = this.getAccountByEmail(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
    const cooldownMs = Math.min(baseMs * 2 ** Math.max(0, acct.failureCount - 1), maxMs);
    acct.cooldownUntil = Date.now() + cooldownMs;
    console.log(
      `Account ${redactForLog(email)} cooled down for ${Math.round(cooldownMs / 1000)}s (${kind})`
    );
    this.persistState();
  }

  async refreshAccount(email: string): Promise<boolean> {
    const acct = this.getAccountByEmail(email);
    if (!acct) return false;
    if (acct.refreshPromise) {
      return acct.refreshPromise;
    }

    acct.refreshPromise = this.performRefresh(acct);
    return acct.refreshPromise;
  }

  getSnapshots(): AccountSnapshot[] {
    if (!this.account) return [];

    return [{
      email: this.account.token.email,
      available: isAccountUsable(this.account),
      cooldownUntil: this.account.cooldownUntil,
      failureCount: this.account.failureCount,
      lastError: this.account.lastError,
      lastFailureAt: this.account.lastFailureAt,
      lastSuccessAt: this.account.lastSuccessAt,
      lastRefreshAt: this.account.lastRefreshAt,
      totalRequests: this.account.totalRequests,
      totalSuccesses: this.account.totalSuccesses,
      totalFailures: this.account.totalFailures,
      expiresAt: this.account.token.expiresAt,
      refreshing: this.account.refreshing,
      refreshFailureCount: this.account.refreshFailureCount,
      nextRefreshAttemptAt: this.account.nextRefreshAttemptAt,
    }];
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () => this.refreshAll().catch((err) => console.error("Refresh cycle failed:", err.message)),
      REFRESH_CHECK_INTERVAL_MS
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) => console.error("Initial refresh failed:", err.message));
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  get accountCount(): number {
    return this.account ? 1 : 0;
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (!this.account) return;

      const expiresAt = new Date(this.account.token.expiresAt).getTime();
      if (expiresAt - Date.now() > REFRESH_LEAD_MS) return;

      // Respect refresh-failure backoff: if the last few refresh attempts
      // all failed, don't keep slamming Anthropic's oauth endpoint every
      // 60s — they may already be IP-rate-limiting us.
      if (Date.now() < this.account.nextRefreshAttemptAt) return;

      await this.refreshAccount(this.account.token.email);
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    if (acct.refreshing) return false;

    acct.refreshing = true;
    try {
      console.log(`Refreshing token for ${redactForLog(acct.token.email)}...`);
      const newToken = await refreshTokensWithRetry(acct.token.refreshToken);
      newToken.email = newToken.email || acct.token.email;
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = new Date().toISOString();
      acct.lastRefreshAt = new Date().toISOString();
      acct.refreshFailureCount = 0;
      acct.nextRefreshAttemptAt = 0;
      saveToken(this.authDir, newToken);
      this.persistState();
      console.log(`Token refreshed, expires ${newToken.expiresAt}`);
      return true;
    } catch (err: any) {
      acct.refreshFailureCount++;
      const backoff = Math.min(
        REFRESH_FAIL_BASE_MS * 2 ** Math.max(0, acct.refreshFailureCount - 1),
        REFRESH_FAIL_MAX_MS
      );
      acct.nextRefreshAttemptAt = Date.now() + backoff;
      // PATCHED 2026-06-06: refresh 失败不再冷却账号（access_token 可能仍有效；真失效由请求层 401 冷却）
      console.error(
        redactForLog(
          `Token refresh failed for ${acct.token.email}: ${err.message} ` +
            `(failure #${acct.refreshFailureCount}, next attempt in ${Math.round(backoff / 1000)}s — ` +
            `run \`node dist/index.js --login\` if refresh_token is stale)`
        )
      );
      this.persistState();
      return false;
    } finally {
      acct.refreshing = false;
      acct.refreshPromise = null;
    }
  }

  private getAccountByEmail(email: string): AccountState | null {
    if (!this.account || this.account.token.email !== email) return null;
    return this.account;
  }

  private get stateFilePath(): string {
    return path.join(this.authDir, ACCOUNT_STATE_FILENAME);
  }

  private loadPersistedStates(): Record<string, PersistedAccountRuntimeState> {
    if (!fs.existsSync(this.stateFilePath)) return {};

    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, "utf-8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.accounts)) {
        console.warn(`Ignoring invalid account state file: ${this.stateFilePath}`);
        return {};
      }

      const accounts: Record<string, PersistedAccountRuntimeState> = {};
      for (const [email, state] of Object.entries(parsed.accounts)) {
        if (isRecord(state)) {
          accounts[email] = state;
        }
      }
      return accounts;
    } catch (err: any) {
      console.warn(`Failed to load account state file ${this.stateFilePath}: ${err.message}`);
      return {};
    }
  }

  private applyPersistedState(acct: AccountState, persisted?: PersistedAccountRuntimeState): void {
    if (!persisted) return;

    acct.cooldownUntil = readNonNegativeNumber(persisted.cooldownUntil, acct.cooldownUntil);
    acct.failureCount = readNonNegativeNumber(persisted.failureCount, acct.failureCount);
    acct.lastError = readNullableString(persisted.lastError, acct.lastError);
    acct.lastFailureAt = readNullableString(persisted.lastFailureAt, acct.lastFailureAt);
    acct.lastSuccessAt = readNullableString(persisted.lastSuccessAt, acct.lastSuccessAt);
    acct.lastRefreshAt = readNullableString(persisted.lastRefreshAt, acct.lastRefreshAt);
    acct.totalRequests = readNonNegativeNumber(persisted.totalRequests, acct.totalRequests);
    acct.totalSuccesses = readNonNegativeNumber(persisted.totalSuccesses, acct.totalSuccesses);
    acct.totalFailures = readNonNegativeNumber(persisted.totalFailures, acct.totalFailures);
    acct.refreshFailureCount = readNonNegativeNumber(
      persisted.refreshFailureCount,
      acct.refreshFailureCount
    );
    acct.nextRefreshAttemptAt = readNonNegativeNumber(
      persisted.nextRefreshAttemptAt,
      acct.nextRefreshAttemptAt
    );
  }

  private persistState(): void {
    if (!this.account) return;

    const acct = this.account;
    const stateFile: PersistedAccountStateFile = {
      version: 1,
      accounts: {
        [acct.token.email]: {
          cooldownUntil: acct.cooldownUntil,
          failureCount: acct.failureCount,
          lastError: acct.lastError,
          lastFailureAt: acct.lastFailureAt,
          lastSuccessAt: acct.lastSuccessAt,
          lastRefreshAt: acct.lastRefreshAt,
          totalRequests: acct.totalRequests,
          totalSuccesses: acct.totalSuccesses,
          totalFailures: acct.totalFailures,
          refreshFailureCount: acct.refreshFailureCount,
          nextRefreshAttemptAt: acct.nextRefreshAttemptAt,
        },
      },
    };

    try {
      fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.stateFilePath, JSON.stringify(stateFile, null, 2), { mode: 0o600 });
    } catch (err: any) {
      console.error(`Failed to persist account state ${this.stateFilePath}: ${err.message}`);
    }
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastRefreshAt: null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      refreshing: false,
      refreshPromise: null,
      refreshFailureCount: 0,
      nextRefreshAttemptAt: 0,
    };
  }
}

function isAccountUsable(acct: AccountState, now = Date.now()): boolean {
  return acct.cooldownUntil <= now && !isTokenExpired(acct.token, now);
}

function isTokenExpired(token: TokenData, now = Date.now()): boolean {
  const expiresAt = Date.parse(token.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now + TOKEN_EXPIRY_SKEW_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null || typeof value === "string") return value;
  return fallback;
}
