import { spawn } from "node:child_process";

const stops = new WeakMap();

// Give each service its own process group, including its workers and wrappers.
export function spawnService(command, args, options) {
  return spawn(command, args, { ...options, detached: process.platform !== "win32" });
}

export function stopService(child, signal = "SIGTERM", graceMs = 5000) {
  if (!child?.pid) return Promise.resolve();
  if (stops.has(child)) return stops.get(child);

  const stopping = new Promise(resolve => {
    if (process.platform === "win32") {
      // Windows has no POSIX process groups; taskkill handles descendants.
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => { child.kill(); resolve(); });
      killer.once("exit", () => resolve());
      return;
    }

    function send(value) {
      try {
        process.kill(-child.pid, value);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    }

    if (!send(signal)) { resolve(); return; }
    // Do not finish just because the wrapper exits: workers may still be alive.
    const poll = setInterval(() => {
      if (!send(0)) finish();
    }, 50);
    const deadline = setTimeout(() => {
      send("SIGKILL");
      finish();
    }, graceMs);
    function finish() {
      clearInterval(poll);
      clearTimeout(deadline);
      resolve();
    }
  });
  stops.set(child, stopping);
  return stopping;
}
