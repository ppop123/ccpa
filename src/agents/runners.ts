import { AgentRunMode, AgentRunnerName, AgentsConfig } from "../config";
import { AgentCommand, AgentCommandInput, AgentRunError } from "./types";

function assertMode(mode: AgentRunMode): void {
  if (mode !== "read-only" && mode !== "workspace-write") {
    throw new AgentRunError(`Unsupported mode: ${String(mode)}`, 400, "unsupported_agent_mode");
  }
}

function runnerCommand(config: AgentsConfig, agent: AgentRunnerName): string {
  const runner = config.runners[agent];
  if (!runner || !runner.enabled) {
    throw new AgentRunError(`Agent runner is disabled: ${agent}`, 503, "agent_runner_disabled");
  }
  return runner.command;
}

export function buildAgentCommand(config: AgentsConfig, input: AgentCommandInput): AgentCommand {
  assertMode(input.mode);
  const command = runnerCommand(config, input.agent);

  if (input.agent === "claude-code") {
    return {
      command,
      cwd: input.workspace,
      args: [
        "-p",
        input.prompt,
        "--output-format",
        "json",
        "--no-session-persistence",
        "--safe-mode",
        "--permission-mode",
        input.mode === "read-only" ? "plan" : "dontAsk",
        "--allowedTools",
        input.mode === "read-only" ? "Read,Grep,Glob,LS" : "Read,Write,Edit,Bash",
      ],
    };
  }

  if (input.agent === "codex-cli") {
    return {
      command,
      cwd: input.workspace,
      args: [
        "exec",
        "--cd",
        input.workspace,
        "--sandbox",
        input.mode === "read-only" ? "read-only" : "workspace-write",
        "--ephemeral",
        input.prompt,
      ],
    };
  }

  if (input.agent === "grok-cli") {
    return {
      command,
      cwd: input.workspace,
      args: [
        "-p",
        input.prompt,
        "--cwd",
        input.workspace,
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--always-approve",
        "--tools",
        input.mode === "read-only" ? "read_file,grep_search,list_dir" : "read_file,search_replace,grep_search,list_dir,bash",
        "--no-memory",
        "--no-subagents",
        "--disable-web-search",
        "--sandbox",
        input.mode === "read-only" ? "read-only" : "workspace",
      ],
    };
  }

  throw new AgentRunError(`Unsupported agent: ${String(input.agent)}`, 400, "unsupported_agent");
}
