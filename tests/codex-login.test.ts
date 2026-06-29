import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCodexLogin } from "../src/auth/codex-login";

class MockChildProcess extends EventEmitter {}

async function withHomeDir<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    return await fn();
  } finally {
    process.env.HOME = originalHome;
  }
}

test("runCodexLogin reports a clear install hint when codex CLI is missing", async () => {
  await assert.rejects(
    runCodexLogin({
      authFilePath: "/tmp/codex-auth.json",
      existsSync: () => false,
      spawn: () => {
        const child = new MockChildProcess();
        process.nextTick(() => {
          const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
          child.emit("error", error);
        });
        return child as any;
      },
    }),
    /install codex cli/i
  );
});

test("runCodexLogin rejects when codex login exits successfully but auth file is still missing", async () => {
  await assert.rejects(
    runCodexLogin({
      authFilePath: "/tmp/codex-auth.json",
      existsSync: () => false,
      spawn: () => {
        const child = new MockChildProcess();
        process.nextTick(() => {
          child.emit("exit", 0);
        });
        return child as any;
      },
    }),
    /auth file not found/i
  );
});

test("runCodexLogin returns the auth file path after successful codex login", async () => {
  const authFilePath = path.join("/tmp", "codex-auth.json");
  const resolvedPath = await runCodexLogin({
    authFilePath,
    existsSync: (candidatePath) => candidatePath === authFilePath,
    spawn: (command, args, options) => {
      assert.equal(command, "codex");
      assert.deepEqual(args, ["login"]);
      assert.equal(options.stdio, "inherit");

      const child = new MockChildProcess();
      process.nextTick(() => {
        child.emit("exit", 0);
      });
      return child as any;
    },
  });

  assert.equal(resolvedPath, authFilePath);
});

test("runCodexLogin fills proxy env from LaunchAgent plist when shell env is missing", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-login-plist-"));
  const plistPath = path.join(tmpDir, "com.wy.ccpa.plist");
  const authFilePath = path.join(tmpDir, "auth.json");
  fs.writeFileSync(authFilePath, "{}");
  fs.writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HTTPS_PROXY</key>",
      "    <string>http://127.0.0.1:6152</string>",
      "    <key>NO_PROXY</key>",
      "    <string>localhost,127.0.0.1,::1,.local</string>",
      "  </dict>",
      "</dict>",
      "</plist>",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await runCodexLogin({
    authFilePath,
    env: { PATH: "/usr/bin" },
    launchAgentPlistPaths: [plistPath],
    existsSync: (candidatePath) => candidatePath === authFilePath,
    spawn: (_command, _args, options) => {
      assert.equal((options as any).env.HTTPS_PROXY, "http://127.0.0.1:6152");
      assert.equal((options as any).env.NO_PROXY, "localhost,127.0.0.1,::1,.local");
      assert.equal((options as any).env.PATH, "/usr/bin");

      const child = new MockChildProcess();
      process.nextTick(() => {
        child.emit("exit", 0);
      });
      return child as any;
    },
  } as any);
});

test("runCodexLogin discovers legacy LaunchAgent plist for proxy env fallback", async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-login-legacy-plist-home-"));
  const launchAgentsDir = path.join(tmpHome, "Library", "LaunchAgents");
  const legacyPlistName = ["com", ["auth2", "api"].join(""), "plist"].join(".");
  const plistPath = path.join(launchAgentsDir, legacyPlistName);
  const authFilePath = path.join(tmpHome, "auth.json");
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.writeFileSync(authFilePath, "{}");
  fs.writeFileSync(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HTTPS_PROXY</key>",
      "    <string>http://127.0.0.1:6152</string>",
      "  </dict>",
      "</dict>",
      "</plist>",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  await withHomeDir(tmpHome, () =>
    runCodexLogin({
      authFilePath,
      env: { PATH: "/usr/bin" },
      existsSync: (candidatePath) => candidatePath === authFilePath,
      spawn: (_command, _args, options) => {
        assert.equal((options as any).env.HTTPS_PROXY, "http://127.0.0.1:6152");

        const child = new MockChildProcess();
        process.nextTick(() => {
          child.emit("exit", 0);
        });
        return child as any;
      },
    } as any)
  );
});

test("runCodexLogin keeps explicit shell proxy env over LaunchAgent plist", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpa-codex-login-env-precedence-"));
  const plistPath = path.join(tmpDir, "com.wy.ccpa.plist");
  const authFilePath = path.join(tmpDir, "auth.json");
  fs.writeFileSync(authFilePath, "{}");
  fs.writeFileSync(
    plistPath,
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HTTPS_PROXY</key>",
      "    <string>http://127.0.0.1:6152</string>",
      "  </dict>",
      "</dict>",
      "</plist>",
    ].join("\n")
  );

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await runCodexLogin({
    authFilePath,
    env: {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:9999",
    },
    launchAgentPlistPaths: [plistPath],
    existsSync: (candidatePath) => candidatePath === authFilePath,
    spawn: (_command, _args, options) => {
      assert.equal((options as any).env.HTTPS_PROXY, "http://127.0.0.1:9999");

      const child = new MockChildProcess();
      process.nextTick(() => {
        child.emit("exit", 0);
      });
      return child as any;
    },
  } as any);
});
