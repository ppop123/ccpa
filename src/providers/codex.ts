import express from "express";
import { Config } from "../config";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { resolveProviderFromModel } from "./router";
import { Provider, ProviderModel, ProviderStatus } from "./types";

const DEFAULT_CODEX_CONFIG = {
  enabled: true,
  "auth-file": "~/.codex/auth.json",
  models: [] as string[],
};

function notImplementedHandler(message: string): express.RequestHandler {
  return (_req, res) => {
    res.status(501).json({ error: { message } });
  };
}

export class CodexProvider implements Provider {
  readonly name = "codex" as const;

  private readonly authStore: CodexAuthStore;
  private readonly codexConfig;

  constructor(private readonly config: Config) {
    this.codexConfig = this.config.codex || DEFAULT_CODEX_CONFIG;
    this.authStore = new CodexAuthStore(this.codexConfig["auth-file"]);
  }

  supportsModel(model: string): boolean {
    return resolveProviderFromModel(model) === this.name;
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

    try {
      const snapshot = this.authStore.load();
      return {
        name: this.name,
        available: true,
        details: {
          enabled: true,
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
            error: error.message,
          },
        };
      }
      throw error;
    }
  }

  handleChatCompletions(): express.RequestHandler {
    return notImplementedHandler("Codex chat completions not implemented");
  }

  handleResponses(): express.RequestHandler {
    return notImplementedHandler("Codex responses not implemented");
  }
}
