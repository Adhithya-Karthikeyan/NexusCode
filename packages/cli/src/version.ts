import { readFileSync } from "node:fs";

/** Read the CLI package version from the manifest beside `dist/`. */
function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Single version source for CLI metadata and the embedded REST server. */
export const NEXUS_VERSION = readVersion();
