import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

export interface CloakingConfig {
  mode: "auto" | "always" | "never";
  "strict-mode": boolean;
  "sensitive-words": string[];
  "cache-user-id": boolean;
  "billing-build-hash"?: string;
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface CodexConfig {
  enabled: boolean;
  "auth-file": string;
  store: boolean;
  models: string[];
}

export interface ClaudeConfig {
  models: string[];
  "beta-header": string;
}

export interface RateLimitConfig {
  enabled: boolean;
  "window-ms": number;
  "max-requests": number;
}

export type DebugMode = "off" | "errors" | "verbose";

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": string[];
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  claude?: ClaudeConfig;
  codex: CodexConfig;
  "rate-limit"?: RateLimitConfig;
  debug: DebugMode;
}

export const DEFAULT_CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const;

export const DEFAULT_ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05";

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  enabled: false,
  "window-ms": 60_000,
  "max-requests": 60,
};

const DEFAULT_CONFIG: Config = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    mode: "auto",
    "strict-mode": false,
    "sensitive-words": [],
    "cache-user-id": false,
    "billing-build-hash": "000",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  claude: {
    models: [...DEFAULT_CLAUDE_MODELS],
    "beta-header": DEFAULT_ANTHROPIC_BETA,
  },
  codex: {
    enabled: true,
    "auth-file": "~/.codex/auth.json",
    store: false,
    models: [],
  },
  "rate-limit": DEFAULT_RATE_LIMIT_CONFIG,
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose") return value;
  return "off";
}

function normalizeApiKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((key) => (typeof key === "string" ? key.trim() : ""))
    .filter((key) => key.length > 0);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : NaN;
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function normalizeTimeouts(value: unknown): TimeoutConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    "messages-ms": normalizePositiveInteger(
      raw["messages-ms"],
      DEFAULT_CONFIG.timeouts["messages-ms"]
    ),
    "stream-messages-ms": normalizePositiveInteger(
      raw["stream-messages-ms"],
      DEFAULT_CONFIG.timeouts["stream-messages-ms"]
    ),
    "count-tokens-ms": normalizePositiveInteger(
      raw["count-tokens-ms"],
      DEFAULT_CONFIG.timeouts["count-tokens-ms"]
    ),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeRateLimit(value: unknown): RateLimitConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_RATE_LIMIT_CONFIG.enabled),
    "window-ms": normalizePositiveInteger(
      raw["window-ms"],
      DEFAULT_RATE_LIMIT_CONFIG["window-ms"]
    ),
    "max-requests": normalizePositiveInteger(
      raw["max-requests"],
      DEFAULT_RATE_LIMIT_CONFIG["max-requests"]
    ),
  };
}

function normalizeCloaking(value: unknown): CloakingConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const mode =
    raw.mode === "always" || raw.mode === "never" || raw.mode === "auto"
      ? raw.mode
      : DEFAULT_CONFIG.cloaking.mode;
  const billingBuildHash =
    typeof raw["billing-build-hash"] === "string" &&
    /^[0-9a-f]{3}$/i.test(raw["billing-build-hash"].trim())
      ? raw["billing-build-hash"].trim().toLowerCase()
      : DEFAULT_CONFIG.cloaking["billing-build-hash"];
  return {
    mode,
    "strict-mode": normalizeBoolean(
      raw["strict-mode"],
      DEFAULT_CONFIG.cloaking["strict-mode"]
    ),
    "sensitive-words": normalizeStringList(raw["sensitive-words"]),
    "cache-user-id": normalizeBoolean(
      raw["cache-user-id"],
      DEFAULT_CONFIG.cloaking["cache-user-id"]
    ),
    "billing-build-hash": billingBuildHash,
  };
}

export function isDebugLevel(debug: DebugMode, level: Exclude<DebugMode, "off">): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let config: Config;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    config = { ...DEFAULT_CONFIG };
  } else {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as Partial<Config>;
    const parsedClaude = parsed.claude as Partial<ClaudeConfig> | undefined;
    const parsedCodex = parsed.codex as Partial<CodexConfig> | undefined;
    const hasClaudeModelList = Array.isArray(parsedClaude?.models);
    const claudeModels = normalizeStringList(parsedClaude?.models);
    config = {
      ...DEFAULT_CONFIG,
      ...parsed,
      cloaking: normalizeCloaking(parsed.cloaking),
      timeouts: { ...DEFAULT_CONFIG.timeouts, ...(parsed.timeouts || {}) },
      claude: {
        models: hasClaudeModelList ? claudeModels : [...DEFAULT_CLAUDE_MODELS],
        "beta-header":
          typeof parsedClaude?.["beta-header"] === "string" && parsedClaude["beta-header"].trim()
            ? parsedClaude["beta-header"]
            : DEFAULT_ANTHROPIC_BETA,
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        ...(parsedCodex || {}),
        enabled: normalizeBoolean(
          parsedCodex?.enabled,
          DEFAULT_CONFIG.codex.enabled
        ),
        store:
          normalizeBoolean(parsedCodex?.store, DEFAULT_CONFIG.codex.store),
        models: normalizeStringList(parsedCodex?.models),
      },
      "rate-limit": {
        ...DEFAULT_RATE_LIMIT_CONFIG,
        ...((parsed["rate-limit"] as Partial<RateLimitConfig> | undefined) || {}),
      },
    };
  }

  config.debug = normalizeDebugMode((config as Config & { debug?: unknown }).debug);
  config["api-keys"] = normalizeApiKeys((config as Config & { "api-keys"?: unknown })["api-keys"]);
  config.cloaking = normalizeCloaking((config as Config & { cloaking?: unknown }).cloaking);
  config.timeouts = normalizeTimeouts((config as Config & { timeouts?: unknown }).timeouts);
  config["rate-limit"] = normalizeRateLimit(
    (config as Config & { "rate-limit"?: unknown })["rate-limit"]
  );

  // Auto-generate API key if none configured
  if (!config["api-keys"] || config["api-keys"].length === 0) {
    const key = generateApiKey();
    config["api-keys"] = [key];
    // Write config with generated key
    fs.writeFileSync(filePath, yaml.dump(config, { lineWidth: -1 }), { mode: 0o600 });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return config;
}
