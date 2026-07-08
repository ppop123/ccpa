import express from "express";
import fs from "fs";
import { AgentsConfig } from "../config";
import { apiError, invalidRequest, rateLimitError } from "../errors/openai";
import { AgentRunManager } from "./manager";
import { AgentRunError, AgentRunRecord } from "./types";

function publicRun(record: AgentRunRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.status,
    agent: record.agent,
    mode: record.mode,
    created_at: record.created_at,
    started_at: record.started_at,
    finished_at: record.finished_at,
    duration_ms: record.duration_ms,
    exit_code: record.exit_code,
    output_text: record.output_text || "",
    error_text: record.error_text || "",
    changed_files: record.changed_files || [],
    diff: record.diff || "",
    failure_code: record.failure_code,
    artifacts_url: record.artifacts_path ? `/v1/agent-runs/${record.id}/artifacts` : undefined,
  };
}
function sendAgentError(res: express.Response, error: unknown): void {
  if (error instanceof AgentRunError) {
    if (error.statusCode === 429) {
      res.status(429).json(rateLimitError(error.message, error.code));
      return;
    }
    if (error.statusCode >= 500) {
      res.status(error.statusCode).json(apiError(error.message, error.code));
      return;
    }
    res.status(error.statusCode).json(invalidRequest(error.message, error.code));
    return;
  }
  res.status(500).json(apiError("Agent run failed", "agent_run_failed"));
}

export function createAgentRunRouter(config: AgentsConfig | undefined): express.Router {
  const router = express.Router();
  const manager = config ? new AgentRunManager(config) : undefined;

  router.post("/", async (req, res) => {
    if (!config?.enabled || !manager) {
      res.status(503).json(apiError("Agent Runs is disabled", "agent_runs_disabled"));
      return;
    }
    try {
      const started = await manager.createRun(req.body);
      if (req.body?.wait === false) {
        res.status(202).json(publicRun(started));
        return;
      }
      const completed = await manager.waitForRun(started.id, config["sync-wait-ms"]);
      res.status(completed.status === "running" ? 202 : 200).json(publicRun(completed));
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  router.get("/:id", async (req, res) => {
    if (!config?.enabled || !manager) {
      res.status(503).json(apiError("Agent Runs is disabled", "agent_runs_disabled"));
      return;
    }
    const record = manager.getRun(req.params.id);
    if (!record) {
      res.status(404).json(invalidRequest("Agent run not found", "agent_run_not_found"));
      return;
    }
    res.json(publicRun(record));
  });

  router.post("/:id/cancel", async (req, res) => {
    if (!config?.enabled || !manager) {
      res.status(503).json(apiError("Agent Runs is disabled", "agent_runs_disabled"));
      return;
    }
    try {
      const record = await manager.cancelRun(req.params.id);
      res.json(publicRun(record));
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  router.get("/:id/artifacts", async (req, res) => {
    if (!config?.enabled || !manager) {
      res.status(503).json(apiError("Agent Runs is disabled", "agent_runs_disabled"));
      return;
    }
    const record = manager.getRun(req.params.id);
    if (!record) {
      res.status(404).json(invalidRequest("Agent run not found", "agent_run_not_found"));
      return;
    }
    if (!record.artifacts_path || !fs.existsSync(record.artifacts_path)) {
      res.status(409).json(apiError("Agent run artifacts are not ready", "agent_artifacts_not_ready"));
      return;
    }
    res.setHeader("Content-Type", record.artifacts_path.endsWith(".gz") ? "application/gzip" : "application/octet-stream");
    res.download(record.artifacts_path, `${record.id}${record.artifacts_path.endsWith(".gz") ? ".tar.gz" : ".json"}`);
  });

  return router;
}
