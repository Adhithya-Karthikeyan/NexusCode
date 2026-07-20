/**
 * The `"cloud-sso"` {@link AuthStrategy} for cloud SDK providers (AWS Bedrock,
 * GCP Vertex). The cloud SDK authenticates from its OWN credential chain, so we
 * never mint or store a token: `login()` DELEGATES to the vendor's real SSO
 * command (`aws sso login`, `gcloud auth login` /
 * `gcloud auth application-default login`), `status()` detects resolvable
 * credentials offline (env vars + well-known credential files), and
 * `resolveCredential()` returns `"none"` — the SDK reads the chain at call time.
 *
 * The CLI binary + credential detection go through the injectable
 * {@link StrategyExec} so the whole thing is testable offline against a fake.
 */

import { join } from "node:path";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";
import { defaultExec, type StrategyExec } from "./exec.js";

export interface CloudSsoSpec {
  /** NexusCode provider id (`"bedrock"` / `"vertex"`). */
  providerId: string;
  /** Vendor SSO CLI binary (`"aws"` / `"gcloud"`). */
  bin: string;
  /** Human vendor label (e.g. `"AWS SSO"`, `"gcloud"`). */
  label: string;
  /** Argv for the vendor's SSO login (e.g. `["sso","login"]`). */
  loginArgs: string[];
  /**
   * Offline credential detection: true when the SDK's credential chain can
   * plausibly resolve (env vars / credential files present). Injected so the
   * AWS vs GCP chain logic stays with the caller (runtime already owns it).
   */
  credsPresent: (exec: StrategyExec) => boolean;
}

export interface CloudSsoStrategyOptions {
  spec: CloudSsoSpec;
  exec?: StrategyExec;
}

/** AWS credential-chain presence (env or `~/.aws/*`) via the exec seam. */
export function awsCredsPresent(exec: StrategyExec, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return true;
  if (env.AWS_PROFILE) return true;
  if (env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE) return true;
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
  const home = exec.home();
  return exec.fileExists(join(home, ".aws", "credentials")) || exec.fileExists(join(home, ".aws", "config"));
}

/** GCP Application Default Credentials presence via the exec seam. */
export function gcpAdcPresent(exec: StrategyExec, env: NodeJS.ProcessEnv = process.env): boolean {
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && exec.fileExists(gac)) return true;
  const home = exec.home();
  if (exec.fileExists(join(home, ".config", "gcloud", "application_default_credentials.json"))) return true;
  const appData = env.APPDATA;
  if (appData && exec.fileExists(join(appData, "gcloud", "application_default_credentials.json"))) return true;
  return false;
}

/** Build a `"cloud-sso"` strategy from a per-cloud spec. */
export function createCloudSsoStrategy(opts: CloudSsoStrategyOptions): AuthStrategy {
  const { spec } = opts;
  const exec = opts.exec ?? defaultExec();
  const providerId = spec.providerId;
  const label = `cloud-sso (${spec.label})`;

  const status = async (): Promise<AuthStatus> => {
    const creds = spec.credsPresent(exec);
    if (creds) {
      return { providerId, kind: "cloud-sso", loggedIn: true, method: label, detail: `${spec.label} credentials resolvable` };
    }
    const installed = exec.which(spec.bin);
    const detail = installed
      ? `no credentials — run \`nexus login ${providerId}\` (delegates to \`${spec.bin} ${spec.loginArgs.join(" ")}\`)`
      : `no credentials and ${spec.bin} not installed`;
    return { providerId, kind: "cloud-sso", loggedIn: false, method: label, detail };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    if (!exec.which(spec.bin)) {
      throw new Error(
        `${providerId}: ${spec.bin} is not installed — install it to sign in, or configure the ${spec.label} credential chain directly`,
      );
    }
    const result = await exec.run(spec.bin, spec.loginArgs, {
      interactive: true,
      ...(loginOpts.signal ? { signal: loginOpts.signal } : {}),
      ...(loginOpts.timeoutMs !== undefined ? { timeoutMs: loginOpts.timeoutMs } : {}),
    });
    if (result.spawnError) {
      throw new Error(`${providerId}: failed to run \`${spec.bin} ${spec.loginArgs.join(" ")}\`: ${result.spawnError}`);
    }
    if (result.code !== 0 && result.code !== null) {
      throw new Error(
        `${providerId}: \`${spec.bin} ${spec.loginArgs.join(" ")}\` exited ${result.code}${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
      );
    }
    return status();
  };

  const logout = async (): Promise<void> => {
    // The cloud vendor owns the credential store; we never delete it. A future
    // `<bin> sso logout` could be wired here, but it is intentionally a no-op.
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    // The cloud SDK resolves credentials from its own chain at call time.
    return { kind: "none", value: "" };
  };

  return { providerId, kind: "cloud-sso", label, login, logout, status, resolveCredential };
}
