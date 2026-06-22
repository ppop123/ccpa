import { ProxyAgent, setGlobalDispatcher } from "undici";
import { LaunchAgentProxyEnvOptions, buildProxyEnvWithLaunchAgentFallback, resolveProxyUrl } from "./auth/proxy-env";
import { redactProxyUrlForLog } from "./logging/redact";

interface ConfigureOutboundProxyOptions extends LaunchAgentProxyEnvOptions {
  createProxyAgent?: (url: string) => any;
  setDispatcher?: (dispatcher: any) => void;
  log?: (message: string) => void;
}

export function configureOutboundProxy(options: ConfigureOutboundProxyOptions = {}): string {
  const env = buildProxyEnvWithLaunchAgentFallback(options);
  const proxyUrl = resolveProxyUrl(env);
  if (!proxyUrl) {
    return "";
  }

  const createProxyAgent = options.createProxyAgent || ((url: string) => new ProxyAgent(url));
  const setDispatcher = options.setDispatcher || setGlobalDispatcher;
  const log = options.log || console.log;

  setDispatcher(createProxyAgent(proxyUrl));
  log(`Outbound HTTP proxy: ${redactProxyUrlForLog(proxyUrl)}`);
  return proxyUrl;
}
