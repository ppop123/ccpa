import { ProviderName } from "./types";

const CLAUDE_PREFIXES = ["claude-"];
const CODEX_PREFIXES = ["gpt-", "codex-"];
const GROK_PREFIXES = ["grok-"];

export function resolveProviderFromModel(model: string): ProviderName | null {
  if (typeof model !== "string") {
    return null;
  }

  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (CLAUDE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "claude";
  }

  if (CODEX_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "codex";
  }

  if (GROK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "grok";
  }

  if (/^o\d/.test(normalized)) {
    return "codex";
  }

  return null;
}
