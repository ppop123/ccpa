import express from "express";
import { Config, GrokConfig } from "../config";
import { setFailureContext } from "../monitoring/http-usage";
import { apiError, invalidRequest } from "./codex-errors";
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

/** 403 是否属于凭据失效(实测形态:{"code":"unauthenticated:bad-credentials","error":"The OAuth2 access token could not be validated."})。clone 读体,原响应保持可转发。 */
async function isCredential403(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof (body.error as Record<string, unknown> | undefined)?.["message"] === "string"
          ? String((body.error as Record<string, unknown>)["message"])
          : "";
    // 只认实测的失效形态,勿放宽:scope/权限类 403 也会提 access token,不能拿去续期(Codex R2)
    return (
      code.startsWith("unauthenticated") ||
      code.includes("bad-credentials") ||
      /could not be validated/i.test(message)
    );
  } catch {
    return false;
  }
}

function setJsonResponse(res: express.Response, upstream: Response, body: unknown): void {
  const contentType = upstream.headers.get("content-type");
  if (isJsonContentType(contentType) || body === null || typeof body !== "string") {
    res.status(upstream.status).json(body ?? {});
    return;
  }

  res.status(upstream.status).type(contentType || "text/plain").send(body);
}

type JsonRecord = Record<string, unknown>;

type LegacySearchPreparation =
  | { ok: true; request: PreparedGrokRequest }
  | { ok: false; code: string; message: string };

type GrokSuccessMapping =
  | { ok: true; body: JsonRecord }
  | { ok: false; code: string; message: string };

type PreparedGrokRequest = {
  endpointPath: string;
  body: unknown;
  stream: boolean;
  mapSuccess?: (body: unknown) => GrokSuccessMapping;
};

type GrokRequestPreparer = (body: unknown) => LegacySearchPreparation;

function isObjectRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function unsupportedLegacySearch(message: string): LegacySearchPreparation {
  return { ok: false, code: "unsupported_legacy_search_parameter", message };
}

function invalidLegacySearch(message: string): LegacySearchPreparation {
  return { ok: false, code: "invalid_parameter", message };
}

function nonNullField(record: JsonRecord, key: string): boolean {
  return hasOwn(record, key) && record[key] !== null && record[key] !== undefined;
}

function readStringArray(
  record: JsonRecord,
  key: string,
  label: string
): { ok: true; value?: string[] } | { ok: false; message: string } {
  if (!nonNullField(record, key)) {
    return { ok: true };
  }

  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    return { ok: false, message: `${label} must be an array of non-empty strings` };
  }

  return { ok: true, value: value as string[] };
}

function findUnknownField(record: JsonRecord, allowed: Set<string>): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) || null;
}

function collectResponseTextAndCitations(body: JsonRecord): {
  foundText: boolean;
  text: string;
  citations: string[];
} {
  const messages: string[] = [];
  const citations: string[] = [];
  const seenCitations = new Set<string>();

  const addCitation = (value: unknown): void => {
    const url =
      typeof value === "string"
        ? value
        : isObjectRecord(value) && typeof value.url === "string"
          ? value.url
          : null;
    if (url && !seenCitations.has(url)) {
      seenCitations.add(url);
      citations.push(url);
    }
  };

  if (Array.isArray(body.citations)) {
    body.citations.forEach(addCitation);
  }

  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isObjectRecord(item) || item.type !== "message" || item.role !== "assistant") {
        continue;
      }

      const messageParts: string[] = [];
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isObjectRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
            continue;
          }
          messageParts.push(part.text);
          if (Array.isArray(part.annotations)) {
            part.annotations.forEach(addCitation);
          }
        }
      }
      if (messageParts.length > 0) {
        messages.push(messageParts.join(""));
      }
    }
  }

  if (messages.length > 0) {
    return { foundText: true, text: messages.join("\n\n"), citations };
  }
  if (typeof body.output_text === "string") {
    return { foundText: true, text: body.output_text, citations };
  }
  return { foundText: false, text: "", citations };
}

function mapResponsesUsageToChat(value: unknown): JsonRecord | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: inputTokenDetails,
    output_tokens_details: outputTokenDetails,
    ...extras
  } = value;
  const promptTokens = typeof inputTokens === "number" ? inputTokens : 0;
  const completionTokens = typeof outputTokens === "number" ? outputTokens : 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof totalTokens === "number" ? totalTokens : promptTokens + completionTokens,
    ...(isObjectRecord(inputTokenDetails) ? { prompt_tokens_details: inputTokenDetails } : {}),
    ...(isObjectRecord(outputTokenDetails) ? { completion_tokens_details: outputTokenDetails } : {}),
    ...extras,
  };
}

function mapLegacySearchResponse(
  value: unknown,
  fallbackModel: unknown,
  returnCitations: boolean
): GrokSuccessMapping {
  if (!isObjectRecord(value)) {
    return {
      ok: false,
      code: "grok_upstream_invalid_response",
      message: "Grok Responses returned a non-JSON response for legacy Live Search compatibility",
    };
  }

  if (value.status === "failed") {
    return {
      ok: false,
      code: "grok_upstream_invalid_response",
      message: getUpstreamErrorMessage(value, "Grok Responses reported a failed search response"),
    };
  }

  const isIncomplete = value.status === "incomplete";
  const finishReason =
    isIncomplete &&
    isObjectRecord(value.incomplete_details) &&
    value.incomplete_details.reason === "content_filter"
      ? "content_filter"
      : isIncomplete
        ? "length"
        : "stop";
  const output = collectResponseTextAndCitations(value);
  if (!output.foundText && !isIncomplete) {
    return {
      ok: false,
      code: "grok_upstream_invalid_response",
      message: "Grok Responses did not include a final assistant output_text message",
    };
  }

  const usage = mapResponsesUsageToChat(value.usage);
  const response: JsonRecord = {
    id: typeof value.id === "string" ? value.id : "chatcmpl_grok_search",
    object: "chat.completion",
    created:
      typeof value.created_at === "number"
        ? value.created_at
        : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: output.text },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
  if (returnCitations && output.citations.length > 0) {
    response.citations = output.citations;
  }
  return { ok: true, body: response };
}

function prepareLegacySearchChatRequest(value: unknown): LegacySearchPreparation {
  const body = isObjectRecord(value) ? value : {};
  const defaultRequest: PreparedGrokRequest = {
    endpointPath: "chat/completions",
    body: value,
    stream: body.stream === true,
  };
  if (nonNullField(body, "stream") && typeof body.stream !== "boolean") {
    return invalidLegacySearch("stream must be a boolean");
  }

  if (!hasOwn(body, "search_parameters")) {
    return { ok: true, request: defaultRequest };
  }

  if (body.search_parameters === null || body.search_parameters === undefined) {
    const { search_parameters: _searchParameters, ...chatBody } = body;
    return {
      ok: true,
      request: { ...defaultRequest, body: chatBody },
    };
  }
  if (!isObjectRecord(body.search_parameters)) {
    return invalidLegacySearch("search_parameters must be an object");
  }

  const search = body.search_parameters;
  const mode = search.mode ?? "auto";
  if (mode !== "auto" && mode !== "on" && mode !== "off") {
    return invalidLegacySearch("search_parameters.mode must be one of auto, on, or off");
  }

  if (mode === "off") {
    const { search_parameters: _searchParameters, ...chatBody } = body;
    return {
      ok: true,
      request: { ...defaultRequest, body: chatBody },
    };
  }

  if (body.stream === true) {
    return {
      ok: false,
      code: "legacy_live_search_streaming_unsupported",
      message:
        "Deprecated Grok Live Search streaming cannot be translated safely. Use POST /v1/responses with web_search and x_search Agent Tools.",
    };
  }

  const allowedSearchFields = new Set([
    "mode",
    "sources",
    "from_date",
    "to_date",
    "max_search_results",
    "return_citations",
  ]);
  const unknownSearchField = findUnknownField(search, allowedSearchFields);
  if (unknownSearchField) {
    return unsupportedLegacySearch(
      `search_parameters.${unknownSearchField} cannot be translated safely to Responses Agent Tools`
    );
  }
  if (nonNullField(search, "max_search_results")) {
    return unsupportedLegacySearch(
      "search_parameters.max_search_results has no equivalent Responses Agent Tools parameter"
    );
  }
  if (nonNullField(search, "return_citations") && typeof search.return_citations !== "boolean") {
    return invalidLegacySearch("search_parameters.return_citations must be a boolean");
  }

  const readDate = (key: "from_date" | "to_date"): string | undefined => {
    const date = search[key];
    return typeof date === "string" && date ? date : undefined;
  };
  for (const key of ["from_date", "to_date"] as const) {
    if (nonNullField(search, key) && !readDate(key)) {
      return invalidLegacySearch(`search_parameters.${key} must be a non-empty string`);
    }
  }
  const fromDate = readDate("from_date");
  const toDate = readDate("to_date");

  let sources: unknown[];
  if (!nonNullField(search, "sources")) {
    sources = [{ type: "web" }, { type: "x" }];
  } else if (!Array.isArray(search.sources) || search.sources.length === 0) {
    return invalidLegacySearch("search_parameters.sources must be a non-empty array");
  } else {
    sources = search.sources;
  }

  const tools: JsonRecord[] = [];
  const sourceTypes = new Set<string>();
  for (const sourceValue of sources) {
    if (!isObjectRecord(sourceValue) || typeof sourceValue.type !== "string") {
      return invalidLegacySearch("Each search_parameters.sources item must include a string type");
    }
    const sourceType = sourceValue.type;
    if (sourceTypes.has(sourceType)) {
      return unsupportedLegacySearch(`Duplicate ${sourceType} search sources cannot be translated safely`);
    }
    sourceTypes.add(sourceType);

    if (sourceType === "news" || sourceType === "rss") {
      return unsupportedLegacySearch(
        `Legacy ${sourceType} search sources have no lossless Responses Agent Tools equivalent`
      );
    }

    if (sourceType === "web") {
      const unknown = findUnknownField(
        sourceValue,
        new Set(["type", "allowed_websites", "excluded_websites", "country", "safe_search"])
      );
      if (unknown) {
        return unsupportedLegacySearch(`web source field ${unknown} cannot be translated safely`);
      }
      if (nonNullField(sourceValue, "country") || nonNullField(sourceValue, "safe_search")) {
        return unsupportedLegacySearch("web country and safe_search filters have no Agent Tools equivalent");
      }
      const allowed = readStringArray(sourceValue, "allowed_websites", "web.allowed_websites");
      const excluded = readStringArray(sourceValue, "excluded_websites", "web.excluded_websites");
      if (!allowed.ok) return invalidLegacySearch(allowed.message);
      if (!excluded.ok) return invalidLegacySearch(excluded.message);
      if ((allowed.value?.length || 0) > 0 && (excluded.value?.length || 0) > 0) {
        return unsupportedLegacySearch(
          "web.allowed_websites and web.excluded_websites cannot both be used by Responses Agent Tools"
        );
      }
      const filters: JsonRecord = {};
      if (allowed.value?.length) filters.allowed_domains = allowed.value;
      if (excluded.value?.length) filters.excluded_domains = excluded.value;
      tools.push({
        type: "web_search",
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      });
      continue;
    }

    if (sourceType === "x") {
      const unknown = findUnknownField(
        sourceValue,
        new Set([
          "type",
          "included_x_handles",
          "x_handles",
          "excluded_x_handles",
          "post_favorite_count",
          "post_view_count",
        ])
      );
      if (unknown) {
        return unsupportedLegacySearch(`x source field ${unknown} cannot be translated safely`);
      }
      if (
        nonNullField(sourceValue, "post_favorite_count") ||
        nonNullField(sourceValue, "post_view_count")
      ) {
        return unsupportedLegacySearch("X engagement filters have no Responses x_search equivalent");
      }
      if (nonNullField(sourceValue, "included_x_handles") && nonNullField(sourceValue, "x_handles")) {
        return unsupportedLegacySearch(
          "Use only one of included_x_handles or x_handles in a legacy X search source"
        );
      }
      const includedKey = nonNullField(sourceValue, "included_x_handles")
        ? "included_x_handles"
        : "x_handles";
      const included = readStringArray(sourceValue, includedKey, `x.${includedKey}`);
      const excluded = readStringArray(sourceValue, "excluded_x_handles", "x.excluded_x_handles");
      if (!included.ok) return invalidLegacySearch(included.message);
      if (!excluded.ok) return invalidLegacySearch(excluded.message);
      if ((included.value?.length || 0) > 0 && (excluded.value?.length || 0) > 0) {
        return unsupportedLegacySearch(
          "included and excluded X handles cannot both be used by Responses x_search"
        );
      }
      tools.push({
        type: "x_search",
        ...(included.value?.length ? { allowed_x_handles: included.value } : {}),
        ...(excluded.value?.length ? { excluded_x_handles: excluded.value } : {}),
        ...(fromDate ? { from_date: fromDate } : {}),
        ...(toDate ? { to_date: toDate } : {}),
      });
      continue;
    }

    return unsupportedLegacySearch(`Legacy search source type ${sourceType} is not supported`);
  }

  if ((fromDate || toDate) && (sourceTypes.size !== 1 || !sourceTypes.has("x"))) {
    return unsupportedLegacySearch(
      "Legacy from_date and to_date can only be translated with a sole X search source"
    );
  }

  const allowedChatFields = new Set([
    "model",
    "messages",
    "search_parameters",
    "stream",
    "temperature",
    "top_p",
    "user",
    "service_tier",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "reasoning",
    "n",
  ]);
  const unknownChatField = findUnknownField(body, allowedChatFields);
  if (unknownChatField) {
    return unsupportedLegacySearch(
      `Chat field ${unknownChatField} cannot be translated safely with legacy Live Search; use POST /v1/responses`
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidLegacySearch("messages must be a non-empty array for legacy Live Search bridging");
  }
  const simpleMessageRoles = new Set(["system", "developer", "user", "assistant"]);
  for (const message of body.messages) {
    if (!isObjectRecord(message) || !simpleMessageRoles.has(String(message.role))) {
      return invalidLegacySearch(
        "Each legacy Live Search message must use a system, developer, user, or assistant role"
      );
    }
    if (typeof message.content !== "string") {
      return unsupportedLegacySearch(
        "Legacy Live Search bridging currently supports only simple text messages; use POST /v1/responses for multimodal or tool history input"
      );
    }
    const unknownMessageField = findUnknownField(message, new Set(["role", "content"]));
    if (unknownMessageField) {
      return unsupportedLegacySearch(
        `Chat message field ${unknownMessageField} cannot be translated safely; use POST /v1/responses`
      );
    }
  }
  if (nonNullField(body, "n") && body.n !== 1) {
    return unsupportedLegacySearch("Chat n values other than 1 cannot be translated to Responses");
  }
  if (nonNullField(body, "reasoning_effort") && nonNullField(body, "reasoning")) {
    return unsupportedLegacySearch("Use only one of reasoning_effort or reasoning");
  }

  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    if (
      nonNullField(body, key) &&
      (typeof body[key] !== "number" || !Number.isInteger(body[key]) || body[key] <= 0)
    ) {
      return invalidLegacySearch(`${key} must be a positive integer`);
    }
  }
  const maxCompletionTokens =
    typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  if (
    maxCompletionTokens !== undefined &&
    maxTokens !== undefined &&
    maxCompletionTokens !== maxTokens
  ) {
    return unsupportedLegacySearch(
      "Conflicting max_tokens and max_completion_tokens cannot be translated safely"
    );
  }

  const responsesBody: JsonRecord = {
    model: body.model,
    input: body.messages,
    tools,
    tool_choice: mode === "on" ? "required" : "auto",
    stream: false,
  };
  for (const key of ["temperature", "top_p", "user", "service_tier"] as const) {
    if (nonNullField(body, key)) responsesBody[key] = body[key];
  }
  const maxOutputTokens = maxCompletionTokens ?? maxTokens;
  if (maxOutputTokens !== undefined) responsesBody.max_output_tokens = maxOutputTokens;
  if (nonNullField(body, "reasoning_effort")) {
    responsesBody.reasoning = { effort: body.reasoning_effort };
  } else if (nonNullField(body, "reasoning")) {
    responsesBody.reasoning = body.reasoning;
  }
  const returnCitations = search.return_citations !== false;
  if (!returnCitations) responsesBody.include = ["no_inline_citations"];

  return {
    ok: true,
    request: {
      endpointPath: "responses",
      body: responsesBody,
      stream: false,
      mapSuccess: (responseBody) =>
        mapLegacySearchResponse(responseBody, body.model, returnCitations),
    },
  };
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

  supportsImageEdits(model: string): boolean {
    return this.supportsModel(model) && normalizeModelId(model) === "grok-imagine-image-2.0";
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
        // 有 refresh_token 即可自愈(请求路径会自动续期)——启动门禁不应因此拒启(Codex P1)
        if (this.authStore.needsRefresh(snapshot)) {
          return {
            name: this.name,
            available: true,
            details: {
              enabled: true,
              configured: true,
              expired: true,
              refreshable: true,
              expiresAt: snapshot.expiresAt,
              path: snapshot.path,
              hint: "Access token expired; will self-refresh via refresh_token grant on first request.",
            },
          };
        }
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
    return this.createForwardHandler("chat/completions", prepareLegacySearchChatRequest);
  }

  handleResponses(): express.RequestHandler {
    return this.createForwardHandler("responses");
  }

  handleImageGenerations(): express.RequestHandler {
    return this.createForwardHandler("images/generations");
  }

  handleImageEdits(): express.RequestHandler {
    return this.createForwardHandler("images/edits");
  }

  private createForwardHandler(
    endpointPath: string,
    prepare?: GrokRequestPreparer
  ): express.RequestHandler {
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

      const prepared: LegacySearchPreparation = prepare
        ? prepare(req.body)
        : {
            ok: true,
            request: {
              endpointPath,
              body: req.body,
              stream: req.body?.stream === true,
            },
          };
      if (!prepared.ok) {
        setFailureContext(res, {
          stage: "validation",
          kind: prepared.code,
          message: prepared.message,
        });
        res.status(400).json(invalidRequest(prepared.message, prepared.code));
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

      // 预防式自续期:过期或临近过期(提前窗口)时先用 refresh_token 换新,失败再走原有报错路径
      if (this.authStore.needsRefresh(auth)) {
        const refreshed = await this.authStore.refresh(auth);
        if (refreshed) {
          auth = refreshed;
        }
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
        const upstream = await this.callUpstream(
          prepared.request.endpointPath,
          prepared.request.body,
          auth,
          prepared.request.stream
        );
        await this.forwardUpstreamResponse(
          res,
          upstream,
          prepared.request.stream,
          prepared.request.mapSuccess
        );
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

  private async callUpstream(
    endpointPath: string,
    body: unknown,
    auth: GrokAuthSnapshot,
    stream: boolean
  ): Promise<Response> {
    const response = await this.fetchWithAuth(endpointPath, body, auth, stream);
    // x.ai 对失效 token 实测回 403(unauthenticated:bad-credentials),401 也一并兜底;
    // 非凭据类 403(配额/权限/策略)原样转发,不动 token(Codex P2)
    if (response.status === 401) {
      // fall through to refresh
    } else if (response.status === 403) {
      if (!(await isCredential403(response))) {
        return response;
      }
    } else {
      return response;
    }

    // 先看文件是否已被别人(grok CLI)续过;没有就自己用 refresh_token 续一次
    let refreshed = this.authStore.reloadAfterAuthFailure(auth);
    if (!refreshed || refreshed.expired) {
      refreshed = await this.authStore.refresh(auth);
    }
    if (!refreshed || refreshed.expired || refreshed.accessToken === auth.accessToken) {
      return response;
    }

    return this.fetchWithAuth(endpointPath, body, refreshed, stream);
  }

  private fetchWithAuth(
    endpointPath: string,
    body: unknown,
    auth: GrokAuthSnapshot,
    stream: boolean
  ): Promise<Response> {
    const url = `${normalizeBaseUrl(this.grokConfig["base-url"])}/${endpointPath}`;

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
    res: express.Response,
    upstream: Response,
    stream: boolean,
    mapSuccess?: (body: unknown) => GrokSuccessMapping
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

    if (stream) {
      await this.forwardStream(res, upstream);
      return;
    }

    const body = await readUpstreamBody(upstream);
    if (mapSuccess) {
      const mapped = mapSuccess(body);
      if (!mapped.ok) {
        setFailureContext(res, {
          stage: "upstream",
          kind: mapped.code,
          message: mapped.message,
          upstreamStatus: upstream.status,
        });
        res.status(502).json(apiError(mapped.message, mapped.code));
        return;
      }
      res.status(upstream.status).json(mapped.body);
      return;
    }
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
