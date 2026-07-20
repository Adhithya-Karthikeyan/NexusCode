/**
 * Best-effort browser opener. Spawns the platform's URL handler detached and
 * never throws — if launching fails (headless box, no handler), the caller falls
 * back to printing the URL for the user to paste, and, when available, to the
 * device-code flow. We never block on or wait for the child.
 */

import { spawn } from "node:child_process";

/** Resolve the platform command + args to open `url`. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Try to open `url` in the user's browser. Returns `true` if the launcher
 * process was spawned, `false` on any failure. Best-effort and non-blocking.
 */
export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const { command, args } = browserCommand(url, platform);
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      child.once("error", () => done(false));
      // If it didn't error synchronously on spawn, consider the launch issued.
      child.unref();
      setImmediate(() => done(true));
    } catch {
      resolve(false);
    }
  });
}
