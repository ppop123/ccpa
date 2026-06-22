import { spawn as spawnChildProcess } from "node:child_process";
import fs from "node:fs";
import { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { resolveDefaultCodexAuthFile, resolveCodexAuthFile } from "../providers/codex-auth";

type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv }
) => ChildProcess;

interface RunCodexLoginOptions {
  authFilePath?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  launchAgentPlistPaths?: string[];
  readFileSync?: (path: string) => string | Buffer;
  readdirSync?: (path: string) => string[];
  spawn?: SpawnLike;
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export function codexInstallHint(): string {
  return "Codex CLI not found. Install Codex CLI first, then run `codex login` or retry with `--login-codex`.";
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return _match;
  });
}

function parseLaunchAgentEnvironmentVariables(plist: string): Record<string, string> {
  const env: Record<string, string> = {};
  const dictMatch = plist.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!dictMatch) {
    return env;
  }

  const envDict = dictMatch[1];
  const entryRe = /<key>\s*([^<]+?)\s*<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(envDict))) {
    env[decodeXml(match[1].trim())] = decodeXml(match[2].trim());
  }
  return env;
}

function defaultLaunchAgentPlistPaths(readdirSync: (path: string) => string[]): string[] {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const preferred = [
    "com.wy.ccpa.plist",
    "com.wangyan.ccpa.plist",
    "com.auth2api.plist",
  ].map((name) => path.join(launchAgentsDir, name));

  let discovered: string[] = [];
  try {
    discovered = readdirSync(launchAgentsDir)
      .filter((name) => /\.plist$/i.test(name) && /(ccpa|auth2api)/i.test(name))
      .map((name) => path.join(launchAgentsDir, name));
  } catch {
    discovered = [];
  }

  return [...new Set([...preferred, ...discovered])];
}

function loadLaunchAgentProxyEnv(options: RunCodexLoginOptions): Record<string, string> {
  const readFileSync = options.readFileSync || ((filePath: string) => fs.readFileSync(filePath));
  const readdirSync = options.readdirSync || ((dirPath: string) => fs.readdirSync(dirPath));
  const plistPaths = options.launchAgentPlistPaths || defaultLaunchAgentPlistPaths(readdirSync);
  const proxyEnv: Record<string, string> = {};

  for (const plistPath of plistPaths) {
    try {
      const raw = readFileSync(plistPath).toString();
      const env = parseLaunchAgentEnvironmentVariables(raw);
      for (const key of PROXY_ENV_KEYS) {
        if (!proxyEnv[key] && env[key]) {
          proxyEnv[key] = env[key];
        }
      }
    } catch {
      continue;
    }
  }

  return proxyEnv;
}

function buildCodexLoginEnv(options: RunCodexLoginOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.env || process.env) };
  const launchAgentProxyEnv = loadLaunchAgentProxyEnv(options);
  for (const key of PROXY_ENV_KEYS) {
    if (!env[key] && launchAgentProxyEnv[key]) {
      env[key] = launchAgentProxyEnv[key];
    }
  }
  return env;
}

export async function runCodexLogin(options: RunCodexLoginOptions = {}): Promise<string> {
  const command = options.command || "codex";
  const authFilePath = resolveCodexAuthFile(options.authFilePath || resolveDefaultCodexAuthFile());
  const existsSync = options.existsSync || fs.existsSync;
  const spawn = options.spawn || spawnChildProcess;
  const env = buildCodexLoginEnv(options);

  return new Promise((resolve, reject) => {
    const child = spawn(command, ["login"], { stdio: "inherit", env });
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(authFilePath);
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        fail(new Error(codexInstallHint()));
        return;
      }

      fail(error);
    });

    child.once("exit", (code, signal) => {
      if (code !== 0) {
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        fail(new Error(`codex login failed with ${detail}`));
        return;
      }

      if (!existsSync(authFilePath)) {
        fail(new Error(`Codex login completed but auth file not found: ${authFilePath}`));
        return;
      }

      succeed();
    });
  });
}
