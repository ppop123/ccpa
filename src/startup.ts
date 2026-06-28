import { AccountManager } from "./accounts/manager";
import { Config } from "./config";
import { CodexProvider } from "./providers/codex";
import { GrokProvider } from "./providers/grok";

export function canStartServer(config: Config, manager: AccountManager): boolean {
  if (manager.accountCount > 0) {
    return true;
  }

  const codexProvider = new CodexProvider(config);
  if (codexProvider.getStatus().available) {
    return true;
  }

  const grokProvider = new GrokProvider(config);
  return grokProvider.getStatus().available;
}
