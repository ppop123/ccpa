import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

const stableHarnessFiles = [
  "AGENTS.md",
  "README.md",
  "ARCHITECTURE.md",
  "docs/README.md",
  "docs/AGENT_GUIDE.md",
  "docs/QUALITY.md",
  "scripts/verify.sh",
  "scripts/smoke.sh",
];

function writePlaceholderFiles(targetRoot: string, relativePaths: string[]): void {
  for (const relativePath of relativePaths) {
    const filePath = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "placeholder\n");
  }
}

test("harness shell entrypoints start with a valid executable shebang", () => {
  for (const relativePath of ["scripts/verify.sh", "scripts/smoke.sh"]) {
    const filePath = path.join(root, relativePath);
    const content = fs.readFileSync(filePath, "utf8");
    const mode = fs.statSync(filePath).mode;

    assert.match(content, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    assert.notEqual(mode & 0o111, 0, `${relativePath} must be executable`);
  }
});

test("harness check requires the agent usage guide", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-harness-check-"));
  try {
    writePlaceholderFiles(
      tempRoot,
      stableHarnessFiles.filter((relativePath) => relativePath !== "docs/AGENT_GUIDE.md"),
    );

    const scriptPath = path.join(root, "scripts/check-harness.py");
    const result = spawnSync("python3", [scriptPath], {
      cwd: tempRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /docs\/AGENT_GUIDE\.md/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("default harness check passes from the repository root", () => {
  const scriptPath = path.join(root, "scripts/check-harness.py");
  const result = spawnSync("python3", [scriptPath], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Harness check passed\./);
});

test("default harness check does not require local working logs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-harness-stable-"));
  try {
    writePlaceholderFiles(tempRoot, stableHarnessFiles);

    const scriptPath = path.join(root, "scripts/check-harness.py");
    const result = spawnSync("python3", [scriptPath], {
      cwd: tempRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Harness check passed\./);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("working-log checks are opt-in and report every missing log", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-harness-working-logs-"));
  try {
    writePlaceholderFiles(tempRoot, stableHarnessFiles);

    const scriptPath = path.join(root, "scripts/check-harness.py");
    const result = spawnSync("python3", [scriptPath, "--with-working-logs"], {
      cwd: tempRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    for (const relativePath of ["task_plan.md", "findings.md", "progress.md"]) {
      assert.match(result.stdout, new RegExp(relativePath.replace(".", "\\.")));
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
