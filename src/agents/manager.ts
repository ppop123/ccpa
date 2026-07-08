import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { AgentRunMode, AgentsConfig, resolveAuthDir } from "../config";
import { decodeAgentFiles } from "./bundle";
import { buildAgentCommand } from "./runners";
import {
  AgentCommand,
  AgentRunCreateRequest,
  AgentRunError,
  AgentRunRecord,
  AgentRunStatus,
  DecodedAgentFile,
} from "./types";

interface RunningProcess {
  childPid: number;
  kill: () => void;
}

const OUTPUT_LIMIT = 128 * 1024;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const SAFE_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_PAGER: "cat",
  GIT_EDITOR: ":",
};
const SAFE_GIT_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "commit.gpgsign=false",
];

function nowIso(): string {
  return new Date().toISOString();
}

function terminal(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out";
}

function resolveRunsDir(dir: string): string {
  return resolveAuthDir(dir);
}

function makeRunId(): string {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function boundedText(value: string): string {
  if (value.length <= OUTPUT_LIMIT) return value;
  return value.slice(0, OUTPUT_LIMIT) + "\n[truncated]";
}

function ensureInside(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + path.sep)) {
    throw new AgentRunError("Resolved file path escapes workspace", 400, "unsafe_agent_file_path");
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AgentRunError(`Command timed out: ${command}`, 500, "agent_internal_timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function runGitCommand(args: string[], cwd: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("git", [...SAFE_GIT_CONFIG_ARGS, ...args], cwd, timeoutMs, SAFE_GIT_ENV);
}

async function runAgentProcess(
  command: AgentCommand,
  timeoutMs: number,
  logsDir: string,
  onStarted: (running: RunningProcess) => void
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutPath = path.join(logsDir, "stdout.log");
    const stderrPath = path.join(logsDir, "stderr.log");
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;

    const cleanup = () => {
      stdoutStream.end();
      stderrStream.end();
    };
    const kill = () => {
      if (done || !child.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // fall through to direct kill
        }
      }
      child.kill("SIGTERM");
    };
    const running: RunningProcess = { childPid: child.pid || 0, kill };
    onStarted(running);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 2_000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutStream.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrStream.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve({ code, stdout: boundedText(stdout), stderr: boundedText(stderr), timedOut });
    });
  });
}

export class AgentRunManager {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly completions = new Map<string, Promise<AgentRunRecord>>();
  private readonly running = new Map<string, RunningProcess>();
  private runningCount = 0;

  constructor(private readonly config: AgentsConfig) {}

  async createRun(input: AgentRunCreateRequest): Promise<AgentRunRecord> {
    if (!this.config.enabled) {
      throw new AgentRunError("Agent Runs is disabled", 503, "agent_runs_disabled");
    }
    if (this.runningCount >= this.config["max-concurrency"]) {
      throw new AgentRunError("Agent Runs concurrency limit exceeded", 429, "agent_concurrency_exceeded");
    }
    if (!input || typeof input !== "object") {
      throw new AgentRunError("Agent run request body is required", 400, "invalid_agent_run_request");
    }
    if (!input.agent || !this.config.runners[input.agent]) {
      throw new AgentRunError(`Unsupported agent: ${String(input.agent)}`, 400, "unsupported_agent");
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) {
      throw new AgentRunError("prompt is required", 400, "missing_agent_prompt");
    }
    const mode = (input.mode || "read-only") as AgentRunMode;
    if (mode !== "read-only" && mode !== "workspace-write") {
      throw new AgentRunError(`Unsupported mode: ${String(mode)}`, 400, "unsupported_agent_mode");
    }
    const timeoutMs = Math.min(
      input.timeout_ms && Number.isInteger(input.timeout_ms) && input.timeout_ms > 0
        ? input.timeout_ms
        : this.config["max-runtime-ms"],
      this.config["max-runtime-ms"]
    );
    const decodedFiles = decodeAgentFiles(input.files || [], {
      maxFiles: this.config["max-files"],
      maxFileBytes: this.config["max-file-bytes"],
      maxTotalBytes: this.config["max-total-bytes"],
    });

    const id = makeRunId();
    const runsDir = resolveRunsDir(this.config["runs-dir"]);
    const runPath = path.join(runsDir, id);
    const workspacePath = path.join(runPath, "workspace");
    const logsPath = path.join(runPath, "logs");
    this.runningCount += 1;
    let handedOffToRunner = false;
    try {
      fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      fs.mkdirSync(logsPath, { recursive: true, mode: 0o700 });
      this.writeFiles(workspacePath, decodedFiles);
      await this.createBaseline(workspacePath);

      const record: AgentRunRecord = {
        id,
        status: "running",
        agent: input.agent,
        mode,
        created_at: nowIso(),
        started_at: nowIso(),
        workspace_path: workspacePath,
        run_path: runPath,
        exit_code: null,
        changed_files: [],
      };
      this.runs.set(id, record);

      const completion = this.executeRun(record, prompt, timeoutMs, logsPath);
      this.completions.set(id, completion);
      handedOffToRunner = true;
      return record;
    } catch (error) {
      if (!handedOffToRunner) {
        this.runningCount = Math.max(0, this.runningCount - 1);
      }
      fs.rmSync(runPath, { recursive: true, force: true });
      throw error;
    }
  }

  getRun(id: string): AgentRunRecord | undefined {
    return this.runs.get(id);
  }

  async waitForRun(id: string, waitMs: number): Promise<AgentRunRecord> {
    const record = this.getRun(id);
    if (!record) {
      throw new AgentRunError("Agent run not found", 404, "agent_run_not_found");
    }
    if (terminal(record.status) && record.finished_at) {
      return record;
    }
    const completion = this.completions.get(id);
    if (!completion) {
      return record;
    }
    return Promise.race([
      completion,
      new Promise<AgentRunRecord>((resolve) => setTimeout(() => resolve(record), waitMs)),
    ]);
  }

  async cancelRun(id: string): Promise<AgentRunRecord> {
    const record = this.getRun(id);
    if (!record) {
      throw new AgentRunError("Agent run not found", 404, "agent_run_not_found");
    }
    const running = this.running.get(id);
    if (running && !terminal(record.status)) {
      record.status = "canceled";
      record.failure_code = "agent_run_canceled";
      running.kill();
    }
    return record;
  }

  private writeFiles(workspace: string, files: DecodedAgentFile[]): void {
    for (const file of files) {
      const destination = path.join(workspace, file.path);
      ensureInside(workspace, destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, file.content, { mode: 0o600 });
    }
  }

  private async createBaseline(workspace: string): Promise<void> {
    await runGitCommand(["init"], workspace);
    this.writeSafeGitConfig(workspace);
    await runGitCommand(["config", "user.email", "ccpa-agent-runs@example.local"], workspace);
    await runGitCommand(["config", "user.name", "CCPA Agent Runs"], workspace);
    await runGitCommand(["add", "-A"], workspace);
    await runGitCommand(["commit", "--allow-empty", "-m", "ccpa-agent-runs-baseline"], workspace);
  }

  private async executeRun(record: AgentRunRecord, prompt: string, timeoutMs: number, logsPath: string): Promise<AgentRunRecord> {
    const startedAt = Date.now();
    try {
      const command = buildAgentCommand(this.config, {
        agent: record.agent,
        mode: record.mode,
        prompt,
        workspace: record.workspace_path,
      });
      const processPromise = runAgentProcess(command, timeoutMs, logsPath, (running) => {
        this.running.set(record.id, running);
      });
      const result = await processPromise;
      record.exit_code = result.code;
      record.output_text = result.stdout;
      record.error_text = result.stderr;
      if (record.status === "canceled") {
        record.failure_code = "agent_run_canceled";
      } else if (result.timedOut) {
        record.status = "timed_out";
        record.failure_code = "agent_run_timed_out";
      } else {
        record.status = result.code === 0 ? "completed" : "failed";
        if (result.code !== 0) record.failure_code = "agent_runner_failed";
      }
      await this.collectDiff(record);
      await this.writeResultArtifacts(record);
      return record;
    } catch (error: any) {
      if (record.status !== "canceled") {
        record.status = "failed";
        record.failure_code = error?.code || "agent_run_failed";
      }
      record.error_text = boundedText(String(error?.message || error));
      await this.writeResultArtifacts(record).catch(() => undefined);
      return record;
    } finally {
      this.running.delete(record.id);
      this.runningCount = Math.max(0, this.runningCount - 1);
      record.finished_at = record.finished_at || nowIso();
      record.duration_ms = Date.now() - startedAt;
      this.cleanupOldRuns();
    }
  }

  private async collectDiff(record: AgentRunRecord): Promise<void> {
    this.writeSafeGitConfig(record.workspace_path);
    await runGitCommand(["add", "-N", "."], record.workspace_path).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    const names = await runGitCommand(["diff", "--no-ext-diff", "--name-only"], record.workspace_path);
    const diff = await runGitCommand(["diff", "--no-ext-diff", "--binary", "--no-color"], record.workspace_path);
    record.changed_files = names.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    record.diff = diff.stdout;
  }

  private async writeResultArtifacts(record: AgentRunRecord): Promise<void> {
    fs.writeFileSync(path.join(record.run_path, "result.json"), JSON.stringify(this.publicRecord(record), null, 2));
    fs.writeFileSync(path.join(record.run_path, "diff.patch"), record.diff || "");
    const artifactPath = path.join(record.run_path, "artifacts.tar.gz");
    await runCommand(
      "tar",
      [
        "--exclude",
        "workspace/.git",
        "--exclude",
        "workspace/.git/*",
        "-czf",
        artifactPath,
        "workspace",
        "logs",
        "result.json",
        "diff.patch",
      ],
      record.run_path
    ).catch(() => {
      const fallbackPath = path.join(record.run_path, "artifacts.json");
      fs.writeFileSync(fallbackPath, JSON.stringify(this.publicRecord(record), null, 2));
      record.artifacts_path = fallbackPath;
      return { code: 0, stdout: "", stderr: "" };
    });
    if (!record.artifacts_path) {
      record.artifacts_path = artifactPath;
    }
  }

  publicRecord(record: AgentRunRecord): AgentRunRecord {
    return { ...record };
  }

  private writeSafeGitConfig(workspace: string): void {
    const gitDir = path.join(workspace, ".git");
    const gitDirStat = fs.lstatSync(gitDir);
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
      throw new AgentRunError("Agent workspace git metadata is unsafe", 500, "unsafe_agent_git_metadata");
    }
    const configPath = path.join(gitDir, "config");
    fs.rmSync(configPath, { force: true });
    fs.writeFileSync(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = true",
        "\tbare = false",
        "\tlogallrefupdates = true",
        "[diff]",
        "\texternal =",
        "[commit]",
        "\tgpgsign = false",
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
  }

  private cleanupOldRuns(): void {
    const keep = Math.max(1, this.config["keep-runs"]);
    const completed = Array.from(this.runs.values())
      .filter((run) => terminal(run.status) && !!run.finished_at)
      .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)));
    while (completed.length > keep) {
      const stale = completed.shift();
      if (!stale) break;
      this.runs.delete(stale.id);
      this.completions.delete(stale.id);
      fs.rmSync(stale.run_path, { recursive: true, force: true });
    }
  }
}
