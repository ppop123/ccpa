import express from "express";
import { AccountManager } from "../accounts/manager";
import { Config, DEFAULT_CLAUDE_MODELS } from "../config";
import { createChatCompletionsHandler } from "../proxy/handler";
import { createMessagesHandler, createCountTokensHandler } from "../proxy/passthrough";
import { createResponsesHandler } from "../proxy/responses";
import { Provider, ProviderModel, ProviderStatus } from "./types";

function normalizeConfiguredModels(models: readonly string[] | undefined): string[] {
  const source = models === undefined ? DEFAULT_CLAUDE_MODELS : models;
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const model of source) {
    if (typeof model !== "string") continue;
    const trimmed = model.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function hasDefaultModelSet(modelIds: Set<string>): boolean {
  if (modelIds.size !== DEFAULT_CLAUDE_MODELS.length) {
    return false;
  }
  return DEFAULT_CLAUDE_MODELS.every((model) => modelIds.has(model.toLowerCase()));
}

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  private readonly chatHandler: express.RequestHandler;
  private readonly responsesHandler: express.RequestHandler;
  private readonly messagesHandler: express.RequestHandler;
  private readonly countTokensHandler: express.RequestHandler;
  private readonly modelIds: string[];
  private readonly normalizedModelIds: Set<string>;
  private readonly allowClaudePrefixFallback: boolean;

  constructor(
    private readonly config: Config,
    private readonly manager: AccountManager
  ) {
    this.modelIds = normalizeConfiguredModels(this.config.claude?.models);
    this.normalizedModelIds = new Set(this.modelIds.map((id) => id.toLowerCase()));
    this.allowClaudePrefixFallback = hasDefaultModelSet(this.normalizedModelIds);
    this.chatHandler = createChatCompletionsHandler(this.config, this.manager);
    this.responsesHandler = createResponsesHandler(this.config, this.manager);
    this.messagesHandler = createMessagesHandler(this.config, this.manager);
    this.countTokensHandler = createCountTokensHandler(this.config, this.manager);
  }

  supportsModel(model: string): boolean {
    if (typeof model !== "string") {
      return false;
    }

    const normalized = model.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return this.normalizedModelIds.has(normalized) || (this.allowClaudePrefixFallback && normalized.startsWith("claude-"));
  }

  listModels(): ProviderModel[] {
    return this.modelIds.map((id) => ({
      id,
      ownedBy: "anthropic",
    }));
  }

  getStatus(): ProviderStatus {
    if (this.manager.accountCount === 0) {
      return {
        name: this.name,
        available: false,
        details: {
          accounts: [],
          accountCount: 0,
          hint: "Run `node dist/index.js --login` to make Claude models available.",
        },
      };
    }

    const accounts = this.manager.getSnapshots();

    return {
      name: this.name,
      available: accounts.some((account) => account.available),
      details: {
        accounts,
        accountCount: this.manager.accountCount,
      },
    };
  }

  handleChatCompletions(): express.RequestHandler {
    return this.chatHandler;
  }

  handleResponses(): express.RequestHandler {
    return this.responsesHandler;
  }

  handleMessages(): express.RequestHandler {
    return this.messagesHandler;
  }

  handleCountTokens(): express.RequestHandler {
    return this.countTokensHandler;
  }
}
