import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { spawnService, stopService } from "./process-tree.mjs";

const posixOnly = { skip: process.platform === "win32", timeout: 5000 };

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("shutdown stops a service and repeated shutdown shares completion", posixOnly, async () => {
  const child = spawnService(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout, "data");
    const stopped = stopService(child, "SIGINT", 200);
    assert.equal(stopService(child), stopped);
    await stopped;
    assert.equal(running(child.pid), false);
  } finally {
    await stopService(child);
  }
});

test("shutdown kills an uncooperative descendant after its wrapper exits", posixOnly, async () => {
  const worker = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
  const wrapper = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'inherit' });`;
  const child = spawnService(process.execPath, ["-e", wrapper], { stdio: ["ignore", "pipe", "inherit"] });
  let workerPid;
  try {
    const [output] = await once(child.stdout, "data");
    workerPid = Number(String(output).trim());
    assert.ok(workerPid > 0);
    const outputClosed = once(child.stdout, "close");
    await stopService(child, "SIGTERM", 200);
    await outputClosed; // The worker must release inherited stdout, not just its wrapper.
    assert.equal(running(child.pid), false);
  } finally {
    await stopService(child);
    if (workerPid && running(workerPid)) {
      // A killed orphan can remain a zombie until the system reaps it.
      try { process.kill(workerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("shutdown tolerates failed spawns and already-exited services", posixOnly, async () => {
  const failed = spawnService("/nonexistent-dev-test-command", [], { stdio: "ignore" });
  await once(failed, "error");
  await stopService(failed);
  const exited = spawnService(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(exited, "exit");
  await stopService(exited);
});
