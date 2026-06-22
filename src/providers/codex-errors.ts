export {
  apiError,
  invalidRequest,
  openAIError,
  type OpenAIErrorBody,
  type OpenAIErrorType,
} from "../errors/openai";

import { apiError, type OpenAIErrorBody } from "../errors/openai";

export function codexAuthErrorResponse(message: string): { status: number; body: OpenAIErrorBody } {
  return {
    status: 503,
    body: apiError(message, "codex_auth_unavailable"),
  };
}
