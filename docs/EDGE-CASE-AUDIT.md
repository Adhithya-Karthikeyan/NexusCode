# Provider and runtime edge-case audit

Last audited: 2026-07-26

This inventory covers failure modes that can occur while NexusCode talks to a
native provider API, an OpenAI-compatible endpoint, or a wrapped coding CLI such
as Claude Code or Codex. “Covered” means the behavior already existed and is
exercised by tests. “Fixed” identifies behavior corrected during this audit.

## Account, model, and request failures

| Edge case | Expected Nexus behavior | Status |
| --- | --- | --- |
| Missing API key or login | Emit `auth`, show sign-in/key guidance, do not retry | Covered |
| Expired, revoked, or unauthorized credential | Emit `auth`; never expose the credential in UI/history | Covered |
| Temporary request throttling (`429`, `Retry-After`) | Emit `rate_limit`; retry with bounded backoff before output; allow failover | Covered |
| Credits, subscription usage, spending limit, or hard quota exhausted | Emit non-retryable `quota_exhausted`; say the provider usage limit expired/quota is exhausted; allow another provider to take over | **Fixed** |
| Provider overloaded or service unavailable (`5xx`, Anthropic `529`) | Bounded retry before output, then fail over when routed | Covered |
| Invalid/removed model or unsupported request field | Emit `invalid_request` with provider detail | Covered |
| Context window exceeded | Emit `context_length` with shorten/compact/switch-model guidance | Covered |
| Provider safety/content policy blocks the answer | Convert a terminal content-filter finish into a visible `content_filter` error | **Fixed** |
| Provider cancels or reports an unspecified error finish | Convert the finish into a terminal normalized error | **Fixed** |
| Region/account permission denies a model | Emit `auth` or `invalid_request`, preserving the provider’s redacted detail | Covered |

Quota recognition is provider-neutral but understands the common provider
forms: OpenAI/Azure/compatible `insufficient_quota` and billing hard limits,
Anthropic depleted credit/usage messages, Gemini/Vertex quota errors, Bedrock
`ServiceQuotaExceededException`, and Claude/Codex CLI usage-limit diagnostics.
A generic “too many requests” remains a transient `rate_limit`; Nexus does not
misclassify it as a hard account limit.

## Stream and transport failures

| Edge case | Expected Nexus behavior | Status |
| --- | --- | --- |
| DNS, TLS, refused connection, socket reset, or timeout | Normalize to retryable `transport`; bounded retry/failover | Covered |
| Adapter throws instead of yielding an error chunk | Kernel converts the throw into a terminal normalized error | Covered |
| Stream ends without `run-end` or `error` | Kernel synthesizes visible `empty_output` | **Fixed** |
| Provider reports successful `run-end` with no renderable content | Convert it to visible `empty_output` | **Fixed** |
| SDK/proxy supplies content only in the final message, with no deltas | Recover final text/reasoning/tool calls into canonical chunks before `run-end` | **Fixed** |
| Partial output followed by failure | Default to the terminal error; opt-in continuation only for a safety-approved checkpoint, with overlap deduplication | **Improved** |
| Duplicate/post-terminal provider events | Enforce one start/terminal lifecycle and stop at the first terminal event | **Improved** |
| Tool delta/end arrives without a start, duplicate start/id, or mismatched run id | Convert the contract violation into one normalized terminal error | **Fixed** |
| Abort before or during a request | Emit non-retryable `cancelled` and tear down the socket/process | Covered |
| Content-length/output limit reached before any output | Show `empty_output` with output-limit detail | **Fixed** |
| Usage arrives immediately before an error/empty terminal | Do not treat usage alone as provider commitment; preserve failover eligibility | **Fixed** |
| Failed retry leaks multiple `run-start`/session events | Buffer retry preambles; publish only the committed attempt | **Fixed** |

## Wrapped CLI and process failures

| Edge case | Expected Nexus behavior | Status |
| --- | --- | --- |
| Claude/Codex binary is missing or spawn fails | Emit retryable `transport` with a clear spawn diagnosis | Covered |
| CLI exits non-zero | Emit `cli_exit` with redacted stderr and exit code | **Improved** |
| CLI writes the quota/usage error only to stderr or a terminal result | Classify it as `quota_exhausted`, not a generic exit/empty result | **Fixed** |
| CLI writes enough stderr to fill the pipe | Drain stderr concurrently and cap the retained diagnostic; never deadlock | **Fixed** |
| One malformed NDJSON line followed by valid output | Trace a redacted parse warning, recover, and still emit exactly one terminal `run-end` | **Fixed** |
| Entire response is malformed | Emit one terminal `parse` error | **Fixed** |
| One NDJSON line is unbounded/hostile | Reject it before parsing under the configured line-size cap | **Fixed** |
| CLI exits cleanly with no content | Emit `empty_output` | Covered |
| CLI hangs or ignores the first interrupt | Escalate interrupt to termination and reap the child | Covered |
| Health/version probe hangs | Time out and reap it rather than blocking startup | Covered |

## Routing, history, and provider switching

| Edge case | Expected Nexus behavior | Status |
| --- | --- | --- |
| Hard quota on the selected routed provider | Fail over before output to the next healthy candidate | **Fixed** |
| Hard quota is encountered again in another process | Persist the provider/account block and return the limit/reset diagnosis without calling it again | **Fixed** |
| Cooldown expires while several requests arrive | Admit exactly one half-open probe; keep the others blocked until it settles | **Fixed** |
| Two Nexus processes update/probe the same circuit file | Serialize read-modify-write and persist one recoverable probe lease; do not lose either process's account state | **Fixed** |
| Two accounts use the same provider | Scope quota/auth state by a non-secret credential identity; do not block the other account | **Fixed** |
| Credentials are replaced or quota is manually restored | Reset the scoped circuit through key/login flow or `providers reset` | **Fixed** |
| Empty response on the selected routed provider | Fail over before output when another candidate exists | **Fixed** |
| All candidates fail | Emit the last normalized error as the one terminal failure | Covered |
| Candidate fails after partial output with recovery disabled | Keep the partial output and terminal error; do not switch | Covered |
| Candidate fails after partial text/read-only work with recovery enabled | Send an untrusted continuation envelope and emit only the deduplicated missing suffix | **Fixed** |
| Candidate fails with an in-flight/ambiguous/unknown mutation | Refuse continuation | **Fixed** |
| Candidate completed a mutation | Require exact approval for its action id before continuation | **Fixed** |
| Provider changes within one process | Reuse the same session transcript, project context, and transfer state | Covered |
| Provider changes after resume in a new process | Restore the provider-neutral transcript and reassemble project context | Covered |
| Provider switches explicitly or by failover | Send a bounded, redacted, integrity-signed handoff capsule with goal/context/action guards | **Fixed** |
| Direct or native-agent provider exhausts quota without a route rule | Select a compatible distinct provider under the universal policy and report the actual winner | **Fixed** |
| Target has a smaller context window | Compact older history while retaining system/tool state and the current user turn | **Fixed** |
| Target lacks required tools/modalities/reasoning/execution power | Reject it before dispatch and continue to another compatible target | **Fixed** |
| App restarts after handoff but before mutation | Restore the authenticated do-not-repeat/workspace guard from encrypted storage | **Fixed** |
| User returns to Claude Code or Codex | Resume that provider's independent native thread slot while preserving portable Nexus context | **Fixed** |
| Failed turn leaves an unanswered user message in history | Roll it back from live and durable transcripts so the next provider never receives invalid `user,user` history | **Fixed** |
| Response cache is stale after project instructions change | Sign the exact assembled request, invalidating the cache | Covered |
| History/transfer/context enrichment storage fails | Degrade without losing the provider response; emit observability diagnostics where available | Covered |

## User-facing surfaces

| Surface/edge case | Expected Nexus behavior | Status |
| --- | --- | --- |
| TUI error while notification pane is collapsed | Attach and render the error inside the failed conversation turn | **Fixed** |
| TUI provider picker leaves the old model/context/reasoning settings active | Preflight and commit provider, model, context, circuit, and reasoning state atomically; reject without partial state | **Fixed** |
| `nexus chat` receives a non-text error event | Print the error/hint and return non-zero instead of a blank line and exit 0 | **Fixed** |
| `nexus ask`, agent, code, route, and orchestration text output | Render normalized errors and actionable hints | Covered |
| JSON/NDJSON consumers | Receive structured error code/message/retryability | Covered |
| SDK caller uses `.text()` on a failed run | Reject with the normalized `AdapterError`, never resolve to `""` | **Fixed** |
| REST/SSE run fails | Stream the structured error and record run state `error` with `errorCode`/message | **Fixed** |
| Multi-lane text rendering has an empty/error lane | Label the lane and print `(no output)` plus its error | Covered |
| A first-winner race cancels the slower lane | Label it as expected cancellation; do not print an error or duplicate the winner | **Fixed** |
| TUI context/cost commands are opened after usage changes | Read the live event projection, not startup-time zero values | **Fixed** |
| TUI trace is opened in a live session | Show the current session id and exact CLI trace command | **Fixed** |
| JSON mutation output is consumed by automation | Emit exactly one valid document, including jobs that produce child output | **Fixed** |
| Historical JSON contains a malformed legacy payload | Preserve the raw payload rather than crashing the whole inspection | **Fixed** |

## Verification and external boundary

The repository-wide verification for this audit is:

- all workspace TypeScript checks passing;
- 2,049 tests passing across 209 executed test files;
- focused quota integration through a real local HTTP 429
  `insufficient_quota` response;
- native-provider mapping tests for OpenAI-compatible, Anthropic, Gemini,
  Vertex, and Bedrock;
- controlled Claude/Codex-style subprocess tests;
- persisted provider-circuit restart/status/reset integration;
- signed handoff-capsule assertion on the replacement provider's HTTP request;
- partial-recovery safety, overlap, and malformed-stream chaos contracts;
- end-to-end coverage for core retry/failover, TUI, CLI chat, SDK, REST/SSE,
  live transcript rollback, and durable resume.

No paid provider account was consumed by the automated suite. Remote account
state—actual credits, organization policy, region access, installed vendor CLI
version, and provider availability—remains external. Run `nexus doctor` and one
credentialed smoke request per configured account before deployment. Within the
repository and deterministic integration environments, no known reproducible
silent-response issue remains after this audit.
