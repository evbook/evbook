/**
 * Long-running children (the mock API and the app servers) are started in
 * their own process groups so teardown can take them down together with
 * anything they spawn, even after the harness process itself is gone.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACT_DIR, ROOT } from "./env";

const PID_FILE = resolve(ARTIFACT_DIR, "pids.json");

export interface Started {
  name: string;
  pid: number;
  logFile: string;
}

export function startProcess(name: string, command: string, args: string[], env: Record<string, string> = {}): Started {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const logFile = resolve(ARTIFACT_DIR, `${name}.log`);
  const shown = Object.entries(env)
    .map(([key, value]) => `${key}=${value} `)
    .join("");
  writeFileSync(logFile, `$ ${shown}${command} ${args.join(" ")}\n`);

  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const append = (chunk: Buffer) => appendFileSync(logFile, chunk.toString());
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.unref();

  const started: Started = { name, pid: child.pid!, logFile };
  const existing = readPids();
  writePids([...existing, started]);
  return started;
}

function readPids(): Started[] {
  if (!existsSync(PID_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8")) as Started[];
  } catch {
    return [];
  }
}

function writePids(pids: Started[]): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

/** Kill everything this harness started, process group and all. */
export function stopAll(): void {
  for (const { pid } of readPids()) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(PID_FILE, { force: true });
}

/** Poll a URL until it answers, or give up with the child's log to look at. */
export async function waitForHttp(url: string, { timeoutMs = 60_000, logFile = "" } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const log =
    logFile && existsSync(logFile) ? `\n--- ${logFile} ---\n${readFileSync(logFile, "utf8").slice(-2000)}` : "";
  throw new Error(`Timed out waiting for ${url} (${lastError})${log}`);
}
