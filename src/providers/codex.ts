import express from "express";
import { CodexConfig, Config } from "../config";
import { CodexAuthError, CodexAuthStore, resolveDefaultCodexAuthFile } from "./codex-auth";
import { createCodexChatCompletionsHandler } from "./codex-chat";
import { createCodexImageGenerationsHandler } from "./codex-images";
import { createCodexResponsesHandler } from "./codex-responses";
import { resolveProviderFromModel } from "./router";
import { Provider, ProviderModel, ProviderStatus } from "./types";

const DEFAULT_CODEX_CONFIG: CodexConfig = {
  enabled: true,
  "auth-file": "~/.codex/auth.json",
  store: false,
  models: [] as string[],
};

const CODEX_LOGIN_HINT =
  "Run `node dist/index.js --login-codex` or `codex login` to make Codex models available.";

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase();
}

export class CodexProvider implements Provider {
  readonly name = "codex" as const;

  private readonly authStore: CodexAuthStore;
  private readonly codexConfig;
  private readonly chatHandler: express.RequestHandler;
  private readonly responsesHandler: express.RequestHandler;
  private readonly imageGenerationsHandler: express.RequestHandler;

  constructor(private readonly config: Config) {
    this.codexConfig = this.config.codex || DEFAULT_CODEX_CONFIG;
    this.authStore = new CodexAuthStore(
      this.codexConfig["auth-file"],
      resolveDefaultCodexAuthFile()
    );
    const requestOptions = {
      defaultStore: this.codexConfig.store,
      upstreamTimeoutMs: this.config.timeouts["stream-messages-ms"],
    };
    this.chatHandler = createCodexChatCompletionsHandler(this.authStore, requestOptions);
    this.responsesHandler = createCodexResponsesHandler(this.authStore, requestOptions);
    this.imageGenerationsHandler = createCodexImageGenerationsHandler(this.authStore, requestOptions);
  }

  supportsModel(model: string): boolean {
    if (!this.codexConfig.enabled || typeof model !== "string") {
      return false;
    }

    const normalized = normalizeModelId(model);
    if (!normalized || resolveProviderFromModel(normalized) !== this.name) {
      return false;
    }

    return this.codexConfig.models
      .map((id) => normalizeModelId(id))
      .includes(normalized);
  }

  listModels(): ProviderModel[] {
    if (!this.codexConfig.enabled) {
      return [];
    }

    return this.codexConfig.models.map((id) => ({
      id,
      ownedBy: "openai",
    }));
  }

  getStatus(): ProviderStatus {
    if (!this.codexConfig.enabled) {
      return {
        name: this.name,
        available: false,
        details: { enabled: false },
      };
    }

    if (this.codexConfig.models.length === 0) {
      return {
        name: this.name,
        available: false,
        details: {
          enabled: true,
          configured: false,
          error: "No Codex models configured",
          hint: "Set `codex.models` in config.yaml to expose Codex models.",
        },
      };
    }

    try {
      const snapshot = this.authStore.load();
      return {
        name: this.name,
        available: true,
        details: {
          enabled: true,
          configured: true,
          authMode: snapshot.authMode,
          accountId: snapshot.accountId,
          lastRefresh: snapshot.lastRefresh,
          path: snapshot.path,
        },
      };
    } catch (error) {
      if (error instanceof CodexAuthError) {
        return {
          name: this.name,
          available: false,
          details: {
            enabled: true,
            configured: true,
            error: error.message,
            hint: CODEX_LOGIN_HINT,
          },
        };
      }
      throw error;
    }
  }

  handleChatCompletions(): express.RequestHandler {
    return this.chatHandler;
  }

  handleResponses(): express.RequestHandler {
    return this.responsesHandler;
  }

  handleImageGenerations(): express.RequestHandler {
    return this.imageGenerationsHandler;
  }
}
