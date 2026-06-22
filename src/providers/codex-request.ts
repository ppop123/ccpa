function normalizeRole(role: unknown): unknown {
  if (role === "system") {
    return "developer";
  }
  return role;
}

function normalizeInputItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  return {
    ...item,
    role: normalizeRole((item as { role?: unknown }).role),
  };
}

export interface CodexRequestOptions {
  defaultStore?: boolean;
  upstreamTimeoutMs?: number;
}

export function normalizeCodexRequestBody(body: any, options: CodexRequestOptions = {}): any {
  const normalized = body && typeof body === "object" ? { ...body } : {};
  const defaultStore = options.defaultStore ?? false;

  if (typeof normalized.instructions !== "string") {
    normalized.instructions = "";
  }

  normalized.store = typeof normalized.store === "boolean" ? normalized.store : defaultStore;

  if (typeof normalized.input === "string") {
    normalized.input = [{ role: "user", content: normalized.input }];
  }

  if (Array.isArray(normalized.input)) {
    normalized.input = normalized.input.map((item: unknown) => normalizeInputItem(item));
  }

  return normalized;
}
