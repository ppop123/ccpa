export type OpenAIErrorType =
  | "invalid_request_error"
  | "api_error"
  | "authentication_error"
  | "rate_limit_error";

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    code?: string;
  };
}

export function openAIError(
  message: string,
  type: OpenAIErrorType,
  code?: string
): OpenAIErrorBody {
  return {
    error: {
      message,
      type,
      ...(code ? { code } : {}),
    },
  };
}

export function invalidRequest(message: string, code?: string): OpenAIErrorBody {
  return openAIError(message, "invalid_request_error", code);
}

export function apiError(message: string, code?: string): OpenAIErrorBody {
  return openAIError(message, "api_error", code);
}

export function authenticationError(message: string, code?: string): OpenAIErrorBody {
  return openAIError(message, "authentication_error", code);
}

export function rateLimitError(message: string, code?: string): OpenAIErrorBody {
  return openAIError(message, "rate_limit_error", code);
}
