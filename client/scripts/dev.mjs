import { spawnService, stopService } from "./process-tree.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(clientRoot, "..");
const backendWatcher = path.join(repositoryRoot, "scripts/dev-server.mjs");
const node = process.execPath;

const backend = spawnService(node, [backendWatcher], {
  cwd: repositoryRoot,
  stdio: ["ignore", "pipe", "inherit"],
});

let stdoutBuffer = "";
let next;
let handshakeCount = 0;
let stopping = false;
let restartChain = Promise.resolve();
const startupTimeout = setTimeout(() => fail(new Error("Timed out waiting for the SillyTavern companion handshake.")), 60_000);

function fail(error) {
  if (stopping) return;
  console.error(`[client] ${error.message}`);
  process.exitCode = 1;
  void shutdown("SIGTERM");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimeout);
  await Promise.all([stopService(next, signal), stopService(backend, signal)]);
}

async function replaceNext(port, token) {
  if (next) {
    const previous = next;
    next = undefined;
    await stopService(previous);
  }
  if (stopping) return;
  next = spawnService(node, [path.join(clientRoot, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1"], {
    cwd: clientRoot,
    env: { ...process.env, NEXT_DIST_DIR: ".next-dev", ST_COMPANION_PORT: String(port), ST_COMPANION_TOKEN: token },
    stdio: "inherit",
  });
  const launched = next;
  launched.on("error", error => fail(error));
  launched.on("exit", code => {
    if (!stopping && next === launched) fail(new Error(`Next.js exited (${code ?? "signal"}).`));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
backend.on("error", fail);
backend.on("exit", (code, signal) => {
  if (!stopping) fail(new Error(`Backend watcher exited (${signal ?? code}).`));
});

backend.stdout.setEncoding("utf8");
backend.stdout.on("data", chunk => {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { console.log(line); continue; }
    if (message.type !== "companion_ready" || !Number.isInteger(message.port) || !/^[0-9a-f]{64}$/.test(message.token ?? "")) {
      console.log(line);
      continue;
    }
    handshakeCount++;
    clearTimeout(startupTimeout);
    console.log(`[client] SillyTavern API ${handshakeCount === 1 ? "started" : "restarted"} at http://127.0.0.1:${message.port}; refreshing client connection`);
    const port = message.port;
    const token = message.token;
    restartChain = restartChain.then(() => replaceNext(port, token)).catch(fail);
    message.token = "";
  }
});
