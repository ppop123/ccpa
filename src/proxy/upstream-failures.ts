import { AccountFailureKind } from "../accounts/manager";

export function classifyAccountFailure(status: number): AccountFailureKind | null {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 408 || status >= 500) return "server";
  return null;
}
