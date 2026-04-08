import { AccountAvailability, AccountFailureKind } from "../accounts/manager";

interface CooldownHttpError {
  status: number;
  message: string;
}

function parseFailureKind(lastError: string | null): AccountFailureKind | null {
  if (!lastError) return null;

  for (const kind of ["rate_limit", "auth", "forbidden", "server", "network"] as const) {
    if (lastError === kind || lastError.startsWith(`${kind}:`)) {
      return kind;
    }
  }

  return null;
}

export function getCooldownHttpError(
  availability: Extract<AccountAvailability, { state: "cooldown" }>
): CooldownHttpError {
  switch (parseFailureKind(availability.lastError)) {
    case "rate_limit":
      return { status: 429, message: "Rate limited on the configured account" };
    case "auth":
      return { status: 401, message: "Authentication failed on the configured account" };
    case "forbidden":
      return { status: 403, message: "Configured account is forbidden" };
    case "network":
      return { status: 502, message: "Configured account is cooling down after an upstream network error" };
    case "server":
      return { status: 503, message: "Configured account is cooling down after an upstream server error" };
    default:
      return { status: 503, message: "Configured account is temporarily unavailable" };
  }
}
