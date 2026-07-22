import { spawn, spawnSync } from "node:child_process";

/**
 * Resolve the grok binary. Honors GROK_BIN so users with a non-standard
 * install location (or a wrapper) can override it.
 */
export function grokBinary() {
  return process.env.GROK_BIN?.trim() || "grok";
}

/**
 * Check whether a binary responds to the given probe args.
 * Returns { available, detail } without throwing.
 */
export function binaryAvailable(binary, args, options = {}) {
  try {
    const result = spawnSync(binary, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout ?? 10_000,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    if (result.error) {
      return { available: false, detail: result.error.message };
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim() || `exited with code ${result.status}`;
      return { available: false, detail };
    }
    return { available: true, detail: (result.stdout || "").trim() };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run a command to completion, capturing stdout/stderr.
 * Supports an AbortSignal and an onStdoutLine callback for streaming.
 *
 * When `processGroup: true` (default for long agent runs), the child is the
 * leader of a new process group so terminateProcess can reap grandchildren
 * (e.g. MCP servers spawned by an inner `grok -p`).
 */
export function runCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useGroup = options.processGroup !== false;
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // detached:true makes the child a session/process-group leader on Unix,
      // which is what lets us kill(-pid) the whole tree on cancel.
      detached: useGroup && process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;

    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      resolve({ ...payload, pid: child.pid ?? null });
    };

    const onAbort = () => {
      terminateProcess(child.pid, { processGroup: useGroup });
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      options.onSpawn?.(child.pid);
    } catch {
      /* ignore observer errors */
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.onStdoutLine) {
        stdoutBuffer += chunk;
        let index;
        while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, index);
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (line.trim()) {
            options.onStdoutLine(line);
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      options.signal?.removeEventListener?.("abort", onAbort);
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (options.onStdoutLine && stdoutBuffer.trim()) {
        options.onStdoutLine(stdoutBuffer);
      }
      finish({ code, signal, stdout, stderr });
    });
  });
}

/** Test whether a process is still alive. */
export function processAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Best-effort terminate a pid (SIGTERM then SIGKILL).
 * When the process was spawned with processGroup/detached, signal the whole
 * group (`-pid`) first so MCP-server grandchildren die with the grok child.
 */
function signal(pid, sig, { processGroup = true } = {}) {
  if (processGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, sig); // process group
      return true;
    } catch {
      /* fall through to single-pid */
    }
  }
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcess(pid, options = {}) {
  if (!pid || !processAlive(pid)) {
    return false;
  }
  const processGroup = options.processGroup !== false;
  const sent = signal(pid, "SIGTERM", { processGroup });
  if (!sent) {
    return false;
  }
  setTimeout(() => {
    if (processAlive(pid)) {
      signal(pid, "SIGKILL", { processGroup });
    }
  }, 2_000).unref?.();
  return true;
}
