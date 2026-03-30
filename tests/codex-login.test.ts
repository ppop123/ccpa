import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { runCodexLogin } from "../src/auth/codex-login";

class MockChildProcess extends EventEmitter {}

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
