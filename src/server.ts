import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import { Config, isDebugLevel } from "./config";
import { AccountManager } from "./accounts/manager";
import { extractApiKey } from "./api-key";
import { renderMonitorPage } from "./monitoring/dashboard-page";
import { resolveUsageProvider, setFailureContext, wrapTrackedHandler } from "./monitoring/http-usage";
import { UsageTracker } from "./monitoring/usage";
import { createAgentRunRouter } from "./agents/routes";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { GrokProvider } from "./providers/grok";
import { resolveProviderFromModel } from "./providers/router";
import { authenticationError, invalidRequest, rateLimitError } from "./errors/openai";
import { redactForLog } from "./logging/redact";

// Timing-safe API key comparison
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare dummy against itself to consume constant time
    const dummy = Buffer.alloc(bufB.length);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function rateLimitBucketKey(req: express.Request): string {
  const apiKey = extractApiKey(req.headers);
  if (apiKey) {
    return `api-key:${crypto.createHash("sha256").update(apiKey).digest("hex")}`;
  }
  return `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function setRateLimitHeaders(
  res: express.Response,
  limit: number,
  remaining: number,
  resetAt: number,
  includeRetryAfter = false
): void {
  const now = Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
  if (includeRetryAfter) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
}

function createRateLimitMiddleware(config: Config["rate-limit"]): express.RequestHandler | null {
  if (!config?.enabled) {
    return null;
  }

  const windowMs = Math.max(1, Math.floor(config["window-ms"]));
  const maxRequests = Math.max(1, Math.floor(config["max-requests"]));
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of buckets) {
      if (now > entry.resetAt) buckets.delete(ip);
    }
  }, Math.max(windowMs, 5 * 60 * 1000));
  cleanupTimer.unref();

  return (req, res, next) => {
    const bucketKey = rateLimitBucketKey(req);
    const now = Date.now();
    const entry = buckets.get(bucketKey);

    if (!entry || now > entry.resetAt) {
      const resetAt = now + windowMs;
      buckets.set(bucketKey, { count: 1, resetAt });
      setRateLimitHeaders(res, maxRequests, maxRequests - 1, resetAt);
      next();
      return;
    }

    entry.count++;
    setRateLimitHeaders(res, maxRequests, maxRequests - entry.count, entry.resetAt, entry.count > maxRequests);
    if (entry.count > maxRequests) {
      res.status(429).json(rateLimitError("Too many requests", "rate_limit_exceeded"));
      return;
    }

    next();
  };
}

const SERVER_STARTED_AT_MS = Date.now();
const SERVER_STARTED_AT = new Date(SERVER_STARTED_AT_MS).toISOString();

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
      ? packageJson.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

const PACKAGE_VERSION = readPackageVersion();

function readRuntimeBuildInfo() {
  const buildInfoPath = process.env.CCPA_BUILD_INFO_FILE || path.resolve(__dirname, "build-info.json");
  if (!fs.existsSync(buildInfoPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const build: Record<string, unknown> = {};
    if (typeof parsed.git_commit === "string" && parsed.git_commit.trim()) {
      build.git_commit = parsed.git_commit.trim();
    }
    if (typeof parsed.git_branch === "string" && parsed.git_branch.trim()) {
      build.git_branch = parsed.git_branch.trim();
    }
    if (typeof parsed.git_dirty === "boolean") {
      build.git_dirty = parsed.git_dirty;
    }
    if (typeof parsed.built_at === "string" && parsed.built_at.trim()) {
      build.built_at = parsed.built_at.trim();
    }

    return Object.keys(build).length > 0 ? build : undefined;
  } catch {
    return undefined;
  }
}

function runtimeIdentity() {
  const build = readRuntimeBuildInfo();
  return {
    service: "ccpa",
    version: PACKAGE_VERSION,
    started_at: SERVER_STARTED_AT,
    uptime_ms: Math.max(0, Date.now() - SERVER_STARTED_AT_MS),
    ...(build ? { build } : {}),
  };
}

function serverReadiness(providerStatuses: Array<{ name: string; available: boolean }>) {
  const unavailable = providerStatuses.filter((provider) => !provider.available).map((provider) => provider.name);
  const available = providerStatuses.length - unavailable.length;
  return {
    ...runtimeIdentity(),
    provider_status: available === providerStatuses.length ? "ok" : available > 0 ? "degraded" : "unavailable",
    providers: {
      total: providerStatuses.length,
      available,
      unavailable,
    },
  };
}

const jsonBodyErrorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
  const error = err as { status?: number; statusCode?: number; type?: string };
  const status = error.status || error.statusCode;

  if (status === 400 && error.type === "entity.parse.failed") {
    res.status(400).json(invalidRequest("Invalid JSON body", "invalid_json"));
    return;
  }

  if (status === 413 && error.type === "entity.too.large") {
    res.status(413).json(invalidRequest("Request body too large", "request_body_too_large"));
    return;
  }

  next(err);
};

export function createServer(config: Config, manager: AccountManager): express.Application {
  const app = express();
  const claudeProvider = new ClaudeProvider(config, manager);
  const codexProvider = new CodexProvider(config);
  const grokProvider = new GrokProvider(config);
  const usageTracker = new UsageTracker();
  const rateLimitMiddleware = createRateLimitMiddleware(config["rate-limit"]);
  const guardClaudeNativeModel =
    (handler: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      const model = req.body?.model;
      if (typeof model === "string" && model.trim().length > 0 && !claudeProvider.supportsModel(model)) {
        setFailureContext(res, {
          stage: "routing",
          kind: "unsupported_model",
          message: `Unsupported model: ${String(model)}`,
        });
        res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
        return;
      }

      handler(req, res, next);
    };
  const routeByModel =
    (
      claudeHandler: express.RequestHandler,
      codexHandler: express.RequestHandler,
      grokHandler: express.RequestHandler,
      endpoint: string
    ): express.RequestHandler =>
    wrapTrackedHandler(
      usageTracker,
      {
        endpoint,
        provider: (req) => {
          const model = req.body?.model;
          const provider = resolveProviderFromModel(model);
          if (provider === "claude" || provider === "codex" || provider === "grok") {
            return provider;
          }
          if (claudeProvider.supportsModel(model)) {
            return "claude";
          }
          if (codexProvider.supportsModel(model)) {
            return "codex";
          }
          if (grokProvider.supportsModel(model)) {
            return "grok";
          }
          return resolveUsageProvider(null);
        },
      },
      (req, res, next) => {
        const model = req.body?.model;
        if (typeof model !== "string" || model.trim().length === 0) {
          setFailureContext(res, {
            stage: "validation",
            kind: "missing_model",
            message: "model is required",
          });
          res.status(400).json(invalidRequest("model is required", "missing_required_parameter"));
          return;
        }

        const provider = resolveProviderFromModel(model);

        if (provider === "grok") {
          if (!grokProvider.supportsModel(model)) {
            setFailureContext(res, {
              stage: "routing",
              kind: "unsupported_model",
              message: `Unsupported model: ${String(model)}`,
            });
            res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
            return;
          }
          grokHandler(req, res, next);
          return;
        }

        if (provider === "codex") {
          if (!codexProvider.supportsModel(model)) {
            setFailureContext(res, {
              stage: "routing",
              kind: "unsupported_model",
              message: `Unsupported model: ${String(model)}`,
            });
            res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
            return;
          }
          codexHandler(req, res, next);
          return;
        }

        if (provider === "claude") {
          if (!claudeProvider.supportsModel(model)) {
            setFailureContext(res, {
              stage: "routing",
              kind: "unsupported_model",
              message: `Unsupported model: ${String(model)}`,
            });
            res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
            return;
          }
          claudeHandler(req, res, next);
          return;
        }

        if (claudeProvider.supportsModel(model)) {
          claudeHandler(req, res, next);
          return;
        }

        if (codexProvider.supportsModel(model)) {
          codexHandler(req, res, next);
          return;
        }

        if (grokProvider.supportsModel(model)) {
          grokHandler(req, res, next);
          return;
        }

        setFailureContext(res, {
          stage: "routing",
          kind: "unsupported_model",
          message: `Unsupported model: ${String(model)}`,
        });
        res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
        return;
      }
    );

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(redactForLog(`[debug] ${req.method} ${req.originalUrl} started`));
      res.on("finish", () => {
        console.error(
          redactForLog(`[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`)
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const key = extractApiKey(req.headers);
    if (!key) {
      res.status(401).json(authenticationError("Missing API key", "missing_api_key"));
      return;
    }
    const valid = config["api-keys"].some((k) => safeCompare(key, k));
    if (!valid) {
      res.status(403).json(authenticationError("Invalid API key", "invalid_api_key"));
      return;
    }
    next();
  };

  app.use("/v1", requireApiKey);
  app.use("/admin", requireApiKey);

  if (rateLimitMiddleware) {
    app.use("/v1", rateLimitMiddleware);
  }

  app.use("/v1", express.json({ limit: config["body-limit"] }));
  app.use("/v1", jsonBodyErrorHandler);
  app.use("/admin", express.json({ limit: config["body-limit"] }));
  app.use("/admin", jsonBodyErrorHandler);

  app.use("/v1/agent-runs", createAgentRunRouter(config.agents));

  // Routes — OpenAI compatible
  app.post(
    "/v1/chat/completions",
    routeByModel(
      claudeProvider.handleChatCompletions(),
      codexProvider.handleChatCompletions(),
      grokProvider.handleChatCompletions(),
      "POST /v1/chat/completions"
    )
  );
  app.post(
    "/v1/responses",
    routeByModel(
      claudeProvider.handleResponses(),
      codexProvider.handleResponses(),
      grokProvider.handleResponses(),
      "POST /v1/responses"
    )
  );
  app.post(
    "/v1/images/generations",
    wrapTrackedHandler(
      usageTracker,
      {
        endpoint: "POST /v1/images/generations",
        provider: (req) => {
          const model = req.body?.model || "gpt-image-2";
          const provider = resolveProviderFromModel(model);
          if (provider === "grok" || grokProvider.supportsModel(model)) {
            return "grok";
          }
          return "codex";
        },
      },
      (req, res, next) => {
        const model = req.body?.model || "gpt-image-2";
        req.body = { ...req.body, model };

        if (resolveProviderFromModel(model) === "grok" || grokProvider.supportsModel(model)) {
          if (!grokProvider.supportsModel(model)) {
            setFailureContext(res, {
              stage: "routing",
              kind: "unsupported_model",
              message: `Unsupported model: ${String(model)}`,
            });
            res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
            return;
          }
          grokProvider.handleImageGenerations()(req, res, next);
          return;
        }

        if (!codexProvider.supportsModel(model)) {
          setFailureContext(res, {
            stage: "routing",
            kind: "unsupported_model",
            message: `Unsupported model: ${String(model)}`,
          });
          res.status(400).json(invalidRequest(`Unsupported model: ${String(model)}`, "unsupported_model"));
          return;
        }
        codexProvider.handleImageGenerations()(req, res, next);
      }
    )
  );

  // Routes — Claude native passthrough
  app.post(
    "/v1/messages/count_tokens",
    wrapTrackedHandler(
      usageTracker,
      { endpoint: "POST /v1/messages/count_tokens", provider: "claude" },
      guardClaudeNativeModel(claudeProvider.handleCountTokens())
    )
  );
  app.post(
    "/v1/messages",
    wrapTrackedHandler(
      usageTracker,
      { endpoint: "POST /v1/messages", provider: "claude" },
      guardClaudeNativeModel(claudeProvider.handleMessages())
    )
  );

  app.get("/v1/models", (_req, res) => {
    const models = [...claudeProvider.listModels(), ...codexProvider.listModels(), ...grokProvider.listModels()];
    res.json({
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: model.ownedBy,
      })),
    });
  });

  app.use("/v1", (req, res) => {
    res.status(404).json({
      error: {
        message: `Endpoint not implemented: ${req.method} ${req.originalUrl}`,
        type: "invalid_request_error",
        code: "endpoint_not_implemented",
      },
    });
  });

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ...runtimeIdentity() });
  });

  app.get("/monitor", (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderMonitorPage());
  });

  app.get("/admin/accounts", (_req, res) => {
    const claudeStatus = claudeProvider.getStatus();
    const codexStatus = codexProvider.getStatus();
    const grokStatus = grokProvider.getStatus();
    const readinessProviders = config.grok?.enabled
      ? [claudeStatus, codexStatus, grokStatus]
      : [claudeStatus, codexStatus];
    res.set("Cache-Control", "no-store").json({
      server: serverReadiness(readinessProviders),
      accounts: manager.getSnapshots(),
      account_count: manager.accountCount,
      claude: claudeStatus,
      codex: codexStatus,
      grok: grokStatus,
      agents: config.agents
        ? {
            enabled: config.agents.enabled,
            "runs-dir": config.agents["runs-dir"],
            "max-concurrency": config.agents["max-concurrency"],
            "max-runtime-ms": config.agents["max-runtime-ms"],
            "max-files": config.agents["max-files"],
            "max-total-bytes": config.agents["max-total-bytes"],
            runners: Object.fromEntries(
              Object.entries(config.agents.runners).map(([name, runner]) => [
                name,
                {
                  enabled: runner.enabled,
                  command: runner.command,
                },
              ])
            ),
          }
        : { enabled: false },
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/usage", (_req, res) => {
    res.set("Cache-Control", "no-store").json(usageTracker.snapshot());
  });

  app.get("/admin/usage/recent", (req, res) => {
    const limit = Number(req.query.limit);
    res.set("Cache-Control", "no-store").json(usageTracker.recent(Number.isFinite(limit) ? limit : undefined));
  });

  app.use("/admin", (req, res) => {
    res.status(404).json(
      invalidRequest(`Endpoint not implemented: ${req.method} ${req.originalUrl}`, "endpoint_not_implemented")
    );
  });

  return app;
}
