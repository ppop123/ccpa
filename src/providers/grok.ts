import express from "express";
import { Config, GrokConfig } from "../config";
import { setFailureContext } from "../monitoring/http-usage";
import { apiError } from "./codex-errors";
import { GrokAuthError, GrokAuthSnapshot, GrokAuthStore, resolveDefaultGrokAuthFile } from "./grok-auth";
import { resolveProviderFromModel } from "./router";
import { Provider, ProviderModel, ProviderStatus } from "./types";

const DEFAULT_GROK_CONFIG: GrokConfig = {
  enabled: false,
  "auth-file": "~/.grok/auth.json",
  "base-url": "https://api.x.ai/v1",
  models: [] as string[],
};

const GROK_LOGIN_HINT =
  "Run `grok login --oauth` to create ~/.grok/auth.json, then enable `grok.models` in config.yaml.";

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isJsonContentType(contentType: string | null): boolean {
  return !!contentType && /\bjson\b/i.test(contentType);
}

function getUpstreamErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, any>;
    if (typeof record.error?.message === "string") {
      return record.error.message;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

async function readUpstreamBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (isJsonContentType(contentType)) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const text = await response.text();
  return text || null;
}

function setJsonResponse(res: express.Response, upstream: Response, body: unknown): void {
  const contentType = upstream.headers.get("content-type");
  if (isJsonContentType(contentType) || body === null || typeof body !== "string") {
    res.status(upstream.status).json(body ?? {});
    return;
  }

  res.status(upstream.status).type(contentType || "text/plain").send(body);
}

export class GrokProvider implements Provider {
  readonly name = "grok" as const;

  private readonly authStore: GrokAuthStore;
  private readonly grokConfig: GrokConfig;

  constructor(private readonly config: Config) {
    this.grokConfig = this.config.grok || DEFAULT_GROK_CONFIG;
    this.authStore = new GrokAuthStore(
      this.grokConfig["auth-file"],
      resolveDefaultGrokAuthFile()
    );
  }

  supportsModel(model: string): boolean {
    if (!this.grokConfig.enabled || typeof model !== "string") {
      return false;
    }

    const normalized = normalizeModelId(model);
    if (!normalized || resolveProviderFromModel(normalized) !== this.name) {
      return false;
    }

    return this.grokConfig.models
      .map((id) => normalizeModelId(id))
      .includes(normalized);
  }

  listModels(): ProviderModel[] {
    if (!this.grokConfig.enabled) {
      return [];
    }

    return this.grokConfig.models.map((id) => ({
      id,
      ownedBy: "xai",
    }));
  }

  getStatus(): ProviderStatus {
    if (!this.grokConfig.enabled) {
      return {
        name: this.name,
        available: false,
        details: { enabled: false },
      };
    }

    if (this.grokConfig.models.length === 0) {
      return {
        name: this.name,
        available: false,
        details: {
          enabled: true,
          configured: false,
          error: "No Grok models configured",
          hint: "Set `grok.models` in config.yaml to expose Grok models.",
        },
      };
    }

    try {
      const snapshot = this.authStore.load();
      if (snapshot.expired) {
        return {
          name: this.name,
          available: false,
          details: {
            enabled: true,
            configured: true,
            expired: true,
            expiresAt: snapshot.expiresAt,
            path: snapshot.path,
            error: "Grok OAuth access token is expired",
            hint: GROK_LOGIN_HINT,
          },
        };
      }

      return {
        name: this.name,
        available: true,
        details: {
          enabled: true,
          configured: true,
          authMode: snapshot.authMode,
          expiresAt: snapshot.expiresAt,
          issuer: snapshot.issuer,
          clientId: snapshot.clientId,
          path: snapshot.path,
        },
      };
    } catch (error) {
      if (error instanceof GrokAuthError) {
        return {
          name: this.name,
          available: false,
          details: {
            enabled: true,
            configured: true,
            error: error.message,
            hint: GROK_LOGIN_HINT,
          },
        };
      }
      throw error;
    }
  }

  handleChatCompletions(): express.RequestHandler {
    return this.createForwardHandler("chat/completions");
  }

  handleResponses(): express.RequestHandler {
    return this.createForwardHandler("responses");
  }

  handleImageGenerations(): express.RequestHandler {
    return this.createForwardHandler("images/generations");
  }

  private createForwardHandler(endpointPath: string): express.RequestHandler {
    return async (req, res) => {
      if (!this.grokConfig.enabled) {
        setFailureContext(res, {
          stage: "routing",
          kind: "provider_disabled",
          message: "Grok provider is disabled",
        });
        res.status(503).json(apiError("Grok provider is disabled", "grok_provider_disabled"));
        return;
      }

      let auth: GrokAuthSnapshot;
      try {
        auth = this.authStore.load();
      } catch (error) {
        if (error instanceof GrokAuthError) {
          setFailureContext(res, {
            stage: "auth",
            kind: "grok_auth_unavailable",
            message: error.message,
          });
          res.status(503).json(apiError(error.message, "grok_auth_unavailable"));
          return;
        }
        throw error;
      }

      if (auth.expired) {
        setFailureContext(res, {
          stage: "auth",
          kind: "grok_auth_expired",
          message: "Grok OAuth access token is expired",
        });
        res.status(503).json(apiError("Grok OAuth access token is expired", "grok_auth_expired"));
        return;
      }

      try {
        const upstream = await this.callUpstream(endpointPath, req.body, auth);
        await this.forwardUpstreamResponse(req, res, upstream);
      } catch (error: any) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "grok_upstream_network_error",
          message: error?.message || "Grok upstream network error",
        });
        res.status(503).json(apiError("Grok upstream network error", "grok_upstream_network_error"));
      }
    };
  }

  private async callUpstream(endpointPath: string, body: unknown, auth: GrokAuthSnapshot): Promise<Response> {
    const response = await this.fetchWithAuth(endpointPath, body, auth);
    if (response.status !== 401) {
      return response;
    }

    const refreshed = this.authStore.reloadAfterAuthFailure(auth);
    if (!refreshed || refreshed.expired) {
      return response;
    }

    return this.fetchWithAuth(endpointPath, body, refreshed);
  }

  private fetchWithAuth(endpointPath: string, body: unknown, auth: GrokAuthSnapshot): Promise<Response> {
    const url = `${normalizeBaseUrl(this.grokConfig["base-url"])}/${endpointPath}`;
    const stream = !!(body && typeof body === "object" && "stream" in body && (body as { stream?: unknown }).stream);

    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  private async forwardUpstreamResponse(
    req: express.Request,
    res: express.Response,
    upstream: Response
  ): Promise<void> {
    if (!upstream.ok) {
      const body = await readUpstreamBody(upstream);
      const message = getUpstreamErrorMessage(body, `Grok upstream request failed with status ${upstream.status}`);
      setFailureContext(res, {
        stage: "upstream",
        kind: "grok_upstream_http_error",
        message,
        upstreamStatus: upstream.status,
      });

      if (body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
        res.status(upstream.status).json(body);
        return;
      }

      res.status(upstream.status).json(apiError(message, "grok_upstream_error"));
      return;
    }

    if (req.body?.stream === true) {
      await this.forwardStream(res, upstream);
      return;
    }

    const body = await readUpstreamBody(upstream);
    setJsonResponse(res, upstream, body);
  }

  private async forwardStream(res: express.Response, upstream: Response): Promise<void> {
    if (!upstream.body) {
      res.status(502).json(apiError("Grok upstream stream response was empty", "grok_upstream_empty_stream"));
      return;
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      res.end();
    }
  }
}
