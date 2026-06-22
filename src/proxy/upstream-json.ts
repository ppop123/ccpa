import { Response as ExpressResponse } from "express";

import { AccountManager } from "../accounts/manager";
import { apiError } from "../errors/openai";
import { setFailureContext } from "../monitoring/http-usage";

export async function readClaudeJsonResponse(
  upstreamResp: globalThis.Response,
  res: ExpressResponse,
  manager: AccountManager,
  accountEmail: string
): Promise<{ ok: true; data: any } | { ok: false }> {
  try {
    return { ok: true, data: await upstreamResp.json() };
  } catch {
    const message = "Upstream returned invalid JSON";
    setFailureContext(res, {
      stage: "upstream",
      kind: "invalid_response",
      message,
      upstreamStatus: upstreamResp.status,
      accountEmail,
    });
    manager.recordFailure(accountEmail, "server", "invalid JSON response");
    res.status(502).json(apiError(message, "upstream_invalid_response"));
    return { ok: false };
  }
}
