import { Response as ExpressResponse } from "express";

import { AccountAvailability } from "../accounts/manager";
import { apiError, rateLimitError } from "../errors/openai";
import { setFailureContext } from "../monitoring/http-usage";

function setRetryAfterFromEpochMs(res: ExpressResponse, retryAtMs: number): void {
  const retryAfterSeconds = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
}

export function setClaudeCooldownRetryAfter(
  res: ExpressResponse,
  availability: AccountAvailability
): void {
  if (availability.state === "cooldown") {
    setRetryAfterFromEpochMs(res, availability.cooldownUntil);
  }
}

export function sendUnavailableClaudeAccount(
  res: ExpressResponse,
  availability: AccountAvailability
): void {
  if (availability.state === "cooldown") {
    setFailureContext(res, {
      stage: "account",
      kind: "cooldown",
      message: "Rate limited on the configured account",
      accountEmail: availability.email,
      accountLastError: availability.lastError,
      cooldownUntil: availability.cooldownUntil,
    });
    setClaudeCooldownRetryAfter(res, availability);
    res.status(429).json(rateLimitError("Rate limited on the configured account", "account_rate_limited"));
    return;
  }

  if (availability.state === "expired") {
    const nextRefreshAttemptAt = availability.nextRefreshAttemptAt;
    const isRefreshBackoffActive = nextRefreshAttemptAt > Date.now();
    const message = isRefreshBackoffActive
      ? "Claude account token is expired; token refresh is backing off"
      : "Claude account token is expired; refresh or login required";
    setFailureContext(res, {
      stage: "account",
      kind: "expired_token",
      message,
      accountEmail: availability.email,
      accountLastError:
        availability.refreshFailureCount > 0
          ? `refresh failures: ${availability.refreshFailureCount}`
          : null,
      cooldownUntil: nextRefreshAttemptAt || null,
    });
    if (isRefreshBackoffActive) {
      setRetryAfterFromEpochMs(res, nextRefreshAttemptAt);
    }
    res.status(503).json(apiError(message, "account_token_expired"));
    return;
  }

  setFailureContext(res, {
    stage: "account",
    kind: "missing_account",
    message: "No available account",
  });
  res.status(503).json(apiError("No available account", "no_available_account"));
}
