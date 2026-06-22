import express from "express";
import { setFailureContext } from "../monitoring/http-usage";
import { CodexAuthError, CodexAuthSnapshot, CodexAuthStore } from "./codex-auth";
import { apiError, invalidRequest } from "./codex-errors";
import { CodexRequestOptions, normalizeCodexRequestBody } from "./codex-request";
import {
  CodexUpstreamInvalidResponseError,
  CodexUpstreamSseError,
  CodexUpstreamTruncatedStreamError,
  collectCodexResponseFromSse,
} from "./codex-sse";
import {
  CodexUpstreamNetworkError,
  CodexUpstreamTimeoutError,
  callCodexResponsesWithAuthRetry,
} from "./codex-upstream";

type ImageResponseFormat = "b64_json" | "url";

interface GeneratedImage {
  b64: string;
  format: string;
}

const IMAGE_RESPONSE_FORMATS = new Set(["b64_json", "url"]);
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const IMAGE_BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_MODERATIONS = new Set(["auto", "low"]);
const IMAGE_STYLES = new Set(["natural", "vivid"]);
const IMAGE_SIZE_MESSAGE =
  "size must be auto or WIDTHxHEIGHT with dimensions divisible by 16, aspect ratio between 1:3 and 3:1, and no more than 3840x2160 pixels";

function resolveCodexImageModel(model: unknown): string {
  if (model === "gpt-image-2") {
    return "gpt-5.5";
  }
  return typeof model === "string" && model ? model : "gpt-5.5";
}

function normalizePrompt(prompt: unknown): string | null {
  if (typeof prompt !== "string") {
    return null;
  }
  const trimmed = prompt.trim();
  return trimmed ? trimmed : null;
}

function normalizeCount(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 1;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    return null;
  }
  return count;
}

function normalizeResponseFormat(value: unknown): ImageResponseFormat {
  return value === "url" ? "url" : "b64_json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failImageValidation(
  res: express.Response,
  kind: string,
  message: string,
  code = "invalid_parameter"
): boolean {
  setFailureContext(res, {
    stage: "validation",
    kind,
    message,
  });
  res.status(400).json(invalidRequest(message, code));
  return true;
}

function getSizeError(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !value) {
    return IMAGE_SIZE_MESSAGE;
  }
  if (value === "auto") {
    return null;
  }

  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    return IMAGE_SIZE_MESSAGE;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  const maxPixels = 3840 * 2160;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    ratio < 1 / 3 ||
    ratio > 3 ||
    width * height > maxPixels
  ) {
    return IMAGE_SIZE_MESSAGE;
  }

  return null;
}

function validateOptionalEnum(
  body: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  message: string
): string | null {
  const value = body[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    return message;
  }
  return null;
}

function validateImageParameters(body: unknown, res: express.Response): boolean {
  if (!isRecord(body)) {
    return false;
  }

  const responseFormatError = validateOptionalEnum(
    body,
    "response_format",
    IMAGE_RESPONSE_FORMATS,
    "response_format must be one of b64_json, url"
  );
  if (responseFormatError) {
    return failImageValidation(res, "invalid_response_format", responseFormatError);
  }

  const sizeError = getSizeError(body.size);
  if (sizeError) {
    return failImageValidation(res, "invalid_size", sizeError);
  }

  const qualityError = validateOptionalEnum(
    body,
    "quality",
    IMAGE_QUALITIES,
    "quality must be one of auto, low, medium, high"
  );
  if (qualityError) {
    return failImageValidation(res, "invalid_quality", qualityError);
  }

  const outputFormatError = validateOptionalEnum(
    body,
    "output_format",
    IMAGE_OUTPUT_FORMATS,
    "output_format must be one of png, jpeg, webp"
  );
  if (outputFormatError) {
    return failImageValidation(res, "invalid_output_format", outputFormatError);
  }

  const outputCompression = body.output_compression;
  if (outputCompression !== undefined) {
    if (
      typeof outputCompression !== "number" ||
      !Number.isInteger(outputCompression) ||
      outputCompression < 0 ||
      outputCompression > 100
    ) {
      return failImageValidation(
        res,
        "invalid_output_compression",
        "output_compression must be an integer between 0 and 100"
      );
    }
    if (body.output_format !== "jpeg" && body.output_format !== "webp") {
      return failImageValidation(
        res,
        "invalid_output_compression",
        "output_compression is only supported for jpeg or webp output_format"
      );
    }
  }

  const backgroundError = validateOptionalEnum(
    body,
    "background",
    IMAGE_BACKGROUNDS,
    "background must be one of auto, opaque, transparent"
  );
  if (backgroundError) {
    return failImageValidation(res, "invalid_background", backgroundError);
  }
  if (body.background === "transparent") {
    return failImageValidation(res, "unsupported_background", "background transparent is unsupported for gpt-image-2");
  }

  const moderationError = validateOptionalEnum(
    body,
    "moderation",
    IMAGE_MODERATIONS,
    "moderation must be one of auto, low"
  );
  if (moderationError) {
    return failImageValidation(res, "invalid_moderation", moderationError);
  }

  if (body.stream !== undefined) {
    if (typeof body.stream !== "boolean") {
      return failImageValidation(res, "invalid_stream", "stream must be a boolean");
    }
    if (body.stream) {
      return failImageValidation(res, "unsupported_stream", "stream is unsupported for /v1/images/generations");
    }
  }

  if (body.partial_images !== undefined) {
    if (
      typeof body.partial_images !== "number" ||
      !Number.isInteger(body.partial_images) ||
      body.partial_images < 0 ||
      body.partial_images > 3
    ) {
      return failImageValidation(res, "invalid_partial_images", "partial_images must be an integer between 0 and 3");
    }
    return failImageValidation(
      res,
      "unsupported_partial_images",
      "partial_images is unsupported for /v1/images/generations"
    );
  }

  if (body.style !== undefined) {
    if (typeof body.style !== "string" || !IMAGE_STYLES.has(body.style)) {
      return failImageValidation(res, "invalid_style", "style must be one of natural, vivid");
    }
    return failImageValidation(res, "unsupported_style", "style is unsupported for gpt-image-2");
  }

  if (body.user !== undefined && typeof body.user !== "string") {
    return failImageValidation(res, "invalid_user", "user must be a string");
  }

  return false;
}

function buildImageTool(body: any): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "image_generation" };
  for (const key of ["size", "quality", "background", "output_format", "moderation"]) {
    if (typeof body?.[key] === "string" && body[key]) {
      tool[key] = body[key];
    }
  }
  if (typeof body?.output_compression === "number") {
    tool.output_compression = body.output_compression;
  }
  return tool;
}

function buildCodexImageRequest(body: any, prompt: string, requestOptions?: CodexRequestOptions): any {
  const requestBody: any = {
    model: resolveCodexImageModel(body?.model),
    input: [{ role: "user", content: prompt }],
    tools: [buildImageTool(body)],
    stream: true,
  };
  if (typeof body?.store === "boolean") {
    requestBody.store = body.store;
  }
  if (typeof body?.user === "string") {
    requestBody.user = body.user;
  }
  return normalizeCodexRequestBody(requestBody, requestOptions);
}

function extractGeneratedImage(upstream: any): GeneratedImage | null {
  if (!Array.isArray(upstream?.output)) {
    return null;
  }

  for (const item of upstream.output) {
    if (item?.type !== "image_generation_call") {
      continue;
    }
    const b64 = item?.result || item?.b64_json || item?.image_b64;
    if (typeof b64 === "string" && b64) {
      return {
        b64,
        format: typeof item?.output_format === "string" && item.output_format ? item.output_format : "png",
      };
    }
  }

  return null;
}

async function generateOneImage(
  authStore: CodexAuthStore,
  snapshot: CodexAuthSnapshot,
  body: any,
  prompt: string,
  requestOptions?: CodexRequestOptions
): Promise<{ image: GeneratedImage; snapshot: CodexAuthSnapshot }> {
  const upstreamRequest = buildCodexImageRequest(body, prompt, requestOptions);
  const { response: upstreamResp, snapshot: currentSnapshot } = await callCodexResponsesWithAuthRetry(
    authStore,
    snapshot,
    upstreamRequest,
    true,
    { timeoutMs: requestOptions?.upstreamTimeoutMs }
  );
  if (!upstreamResp.ok) {
    const text = await upstreamResp.text().catch(() => "");
    const error = new Error(text || "Codex upstream image generation failed") as Error & { status?: number };
    error.status = upstreamResp.status;
    throw error;
  }

  const upstreamJson = await collectCodexResponseFromSse(upstreamResp);
  const image = extractGeneratedImage(upstreamJson);
  if (!image) {
    const error = new Error("Codex upstream response did not contain an image") as Error & { status?: number };
    error.status = 502;
    throw error;
  }
  return { image, snapshot: currentSnapshot };
}

function formatImages(images: GeneratedImage[], prompt: string, responseFormat: ImageResponseFormat): any[] {
  return images.map((image) => {
    const payload =
      responseFormat === "url"
        ? { url: `data:image/${image.format};base64,${image.b64}` }
        : { b64_json: image.b64 };
    return {
      ...payload,
      revised_prompt: prompt,
    };
  });
}

export function createCodexImageGenerationsHandler(
  authStore: CodexAuthStore,
  requestOptions?: CodexRequestOptions
): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const body = req.body || {};
      const prompt = normalizePrompt(body.prompt);
      if (!prompt) {
        setFailureContext(res, {
          stage: "validation",
          kind: "missing_prompt",
          message: "prompt is required",
        });
        res.status(400).json(invalidRequest("prompt is required", "missing_required_parameter"));
        return;
      }

      const count = normalizeCount(body.n);
      if (!count) {
        setFailureContext(res, {
          stage: "validation",
          kind: "invalid_count",
          message: "n must be an integer between 1 and 4",
        });
        res.status(400).json(invalidRequest("n must be an integer between 1 and 4", "invalid_parameter"));
        return;
      }

      if (validateImageParameters(body, res)) {
        return;
      }

      let snapshot;
      try {
        snapshot = authStore.load();
      } catch (error) {
        if (error instanceof CodexAuthError) {
          setFailureContext(res, {
            stage: "provider_auth",
            kind: "codex_auth",
            message: error.message,
          });
          res.status(503).json(apiError(error.message, "codex_auth_unavailable"));
          return;
        }
        throw error;
      }

      const images: GeneratedImage[] = [];
      let currentSnapshot = snapshot;
      for (let i = 0; i < count; i += 1) {
        const generated = await generateOneImage(authStore, currentSnapshot, body, prompt, requestOptions);
        currentSnapshot = generated.snapshot;
        images.push(generated.image);
      }

      res.json({
        created: Math.floor(Date.now() / 1000),
        data: formatImages(images, prompt, normalizeResponseFormat(body.response_format)),
      });
    } catch (error: any) {
      if (error instanceof CodexUpstreamTimeoutError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "timeout",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamNetworkError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamSseError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: error.kind,
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamTruncatedStreamError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "network_error",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      if (error instanceof CodexUpstreamInvalidResponseError) {
        setFailureContext(res, {
          stage: "upstream",
          kind: "invalid_response",
          message: error.message,
          upstreamStatus: error.status,
        });
        res.status(error.status).json(apiError(error.message, error.code));
        return;
      }

      const status = Number.isInteger(error?.status) ? error.status : 500;
      setFailureContext(res, {
        stage: status >= 500 ? "upstream" : "internal",
        kind: status === 401 ? "auth" : status === 429 ? "rate_limit" : "http_error",
        message: error?.message || "Codex image generation failed",
        upstreamStatus: status,
      });
      res.status(status).json(apiError(error?.message || "Codex image generation failed", "codex_upstream_error"));
    }
  };
}
