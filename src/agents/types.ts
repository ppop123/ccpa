import { AgentRunMode, AgentRunnerName } from "../config";

export type AgentRunStatus = "pending" | "running" | "completed" | "failed" | "canceled" | "timed_out";
export type AgentFileEncoding = "utf8" | "base64";

export interface AgentFileInput {
  path: string;
  content: string;
  encoding?: AgentFileEncoding;
}
export interface DecodedAgentFile {
  path: string;
  content: Buffer;
}

export interface AgentFileLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface AgentRunCreateRequest {
  agent: AgentRunnerName;
  prompt: string;
  mode?: AgentRunMode;
  wait?: boolean;
  timeout_ms?: number;
  files?: AgentFileInput[];
}

export interface AgentCommandInput {
  agent: AgentRunnerName;
  mode: AgentRunMode;
  prompt: string;
  workspace: string;
}

export interface AgentCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface AgentRunRecord {
  id: string;
  status: AgentRunStatus;
  agent: AgentRunnerName;
  mode: AgentRunMode;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  workspace_path: string;
  run_path: string;
  artifacts_path?: string;
  exit_code?: number | null;
  output_text?: string;
  error_text?: string;
  changed_files?: string[];
  diff?: string;
  failure_code?: string;
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "agent_run_error"
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}
