import { spawn as spawnChildProcess } from "node:child_process";
import fs from "node:fs";
import { ChildProcess } from "node:child_process";

import { resolveDefaultCodexAuthFile, resolveCodexAuthFile } from "../providers/codex-auth";

type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: "inherit" }
) => ChildProcess;

interface RunCodexLoginOptions {
  authFilePath?: string;
  command?: string;
  existsSync?: typeof fs.existsSync;
  spawn?: SpawnLike;
}

export function codexInstallHint(): string {
  return "Codex CLI not found. Install Codex CLI first, then run `codex login` or retry with `--login-codex`.";
}

export async function runCodexLogin(options: RunCodexLoginOptions = {}): Promise<string> {
  const command = options.command || "codex";
  const authFilePath = resolveCodexAuthFile(options.authFilePath || resolveDefaultCodexAuthFile());
  const existsSync = options.existsSync || fs.existsSync;
  const spawn = options.spawn || spawnChildProcess;

  return new Promise((resolve, reject) => {
    const child = spawn(command, ["login"], { stdio: "inherit" });
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
