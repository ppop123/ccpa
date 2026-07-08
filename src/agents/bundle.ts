import path from "path";
import { AgentFileInput, AgentFileLimits, DecodedAgentFile, AgentRunError } from "./types";

function normalizeSafePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new AgentRunError("File path must be a string", 400, "invalid_agent_file_path");
  }
  const raw = value.trim();
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new AgentRunError(`Unsafe file path: ${String(value)}`, 400, "unsafe_agent_file_path");
  }
  if (path.posix.isAbsolute(raw)) {
    throw new AgentRunError(`Unsafe file path: ${raw}`, 400, "unsafe_agent_file_path");
  }

  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw new AgentRunError(`Unsafe file path: ${raw}`, 400, "unsafe_agent_file_path");
  }

  return normalized;
}
function decodeContent(file: AgentFileInput): Buffer {
  if (typeof file.content !== "string") {
    throw new AgentRunError("File content must be a string", 400, "invalid_agent_file_content");
  }
  const encoding = file.encoding || "utf8";
  if (encoding === "utf8") {
    return Buffer.from(file.content, "utf8");
  }
  if (encoding === "base64") {
    const compact = file.content.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      throw new AgentRunError("Invalid base64 file content", 400, "invalid_agent_file_content");
    }
    return Buffer.from(compact, "base64");
  }
  throw new AgentRunError(`Unsupported file encoding: ${String(encoding)}`, 400, "invalid_agent_file_encoding");
}

export function decodeAgentFiles(files: unknown, limits: AgentFileLimits): DecodedAgentFile[] {
  if (files == null) {
    return [];
  }
  if (!Array.isArray(files)) {
    throw new AgentRunError("files must be an array", 400, "invalid_agent_files");
  }
  if (files.length > limits.maxFiles) {
    throw new AgentRunError("Too many files in agent bundle", 413, "agent_file_count_exceeded");
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  return files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AgentRunError("Each file must be an object", 400, "invalid_agent_file");
    }
    const file = item as AgentFileInput;
    const safePath = normalizeSafePath(file.path);
    if (seen.has(safePath)) {
      throw new AgentRunError(`Duplicate file path: ${safePath}`, 400, "duplicate_agent_file_path");
    }
    seen.add(safePath);

    const content = decodeContent(file);
    if (content.byteLength > limits.maxFileBytes) {
      throw new AgentRunError(`File too large: ${safePath}`, 413, "agent_file_too_large");
    }
    totalBytes += content.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new AgentRunError("Agent file bundle too large", 413, "agent_bundle_too_large");
    }

    return { path: safePath, content };
  });
}
