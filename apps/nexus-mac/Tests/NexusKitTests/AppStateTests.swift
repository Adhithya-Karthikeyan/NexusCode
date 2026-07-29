import XCTest
@testable import NexusKit

/// Presentation logic lives in NexusKit precisely so it can be tested without a
/// window. These cover the two things the UI can get quietly wrong: building the
/// wrong `nexus` command, and misrepresenting what is running.
@MainActor
final class AppStateTests: XCTestCase {
    private func controller() -> ConversationController {
        let binary = NexusBinary(url: URL(fileURLWithPath: "/bin/echo"))
        return ConversationController(
            client: NexusClient(binary: binary),
            binary: binary,
            workingDirectory: URL(fileURLWithPath: "/tmp")
        )
    }

    // MARK: - Command construction

    func testAskBuildsASingleProviderNdjsonCommand() {
        let c = controller()
        c.mode = .ask
        c.provider = "anthropic"
        c.model = "claude-sonnet-4-5"

        let args = c.plannedCommand(for: "hello").arguments
        // `.ask` is single-lane, so `submit()` actually runs this through the
        // persistent `chat --persistent` process (see `submitToPersistentSession`)
        // rather than a one-shot `nexus ask` — the preview must say so, not the
        // subcommand name a one-shot dispatch would use. The prompt itself is
        // never in this argv: it travels over stdin once the backend is ready.
        XCTAssertEqual(args.first, "chat")
        XCTAssertTrue(args.contains("--persistent"))
        XCTAssertFalse(args.contains("hello"))
        // ndjson is what makes the app a renderer rather than a screen-scraper.
        XCTAssertTrue(args.contains("-o") && args.contains("ndjson"))
        XCTAssertTrue(args.contains("-p") && args.contains("anthropic"))
        XCTAssertTrue(args.contains("-m") && args.contains("claude-sonnet-4-5"))
    }

    func testAgentModeWithNoRoleAlsoRunsThroughThePersistentSession() {
        let c = controller()
        c.mode = .agent
        // `.agent` with no role is byte-identical to `.ask` (see
        // `testAgentWithNilRoleIsByteIdenticalToTodaysBehaviour`), so it too
        // previews and runs the persistent `chat --persistent` invocation —
        // never the one-shot `nexus agent` subcommand.
        let args = c.plannedCommand(for: "do it").arguments
        XCTAssertEqual(args.first, "chat")
        XCTAssertFalse(args.contains("do it"))
    }

    func testCompareFansOutAcrossBackendsAndOmitsProviderFlags() {
        let c = controller()
        c.mode = .compare
        c.backends = ["anthropic", "openai"]
        // A stale single-provider selection must not leak into a fan-out run.
        c.provider = "should-be-ignored"

        let args = c.plannedCommand(for: "compare this").arguments
        XCTAssertEqual(args.first, "compare")
        XCTAssertEqual(args.filter { $0 == "-b" }.count, 2)
        XCTAssertTrue(args.contains("anthropic") && args.contains("openai"))
        XCTAssertFalse(args.contains("should-be-ignored"))
        XCTAssertFalse(args.contains("-p"))
    }

    func testRaceUsesTheRaceSubcommand() {
        let c = controller()
        c.mode = .race
        c.backends = ["a", "b"]
        XCTAssertEqual(c.plannedCommand(for: "x").arguments.first, "race")
    }

    func testResumeIsThreadedSoFollowUpTurnsKeepContext() {
        let c = controller()
        c.sessionId = "s_123"
        let args = c.plannedCommand(for: "again").arguments
        XCTAssertTrue(args.contains("--resume"))
        XCTAssertTrue(args.contains("s_123"))
    }

    // MARK: - Preview/spawn parity matrix (Bug 1 + never-sends---effort regression guard)

    /// "The preview shows a command that isn't what runs" has recurred TWICE:
    /// first as `nexus agent …` displayed while `chat --persistent …` actually
    /// ran (Bug 1, originally guarded by a single hand-picked case here), then
    /// as `--effort` spliced into `commandPreview` while neither real argv
    /// builder ever added it. Both were fixed as one-off patches; neither fix
    /// prevented the next one. This replaces the single-case guard with a full
    /// state matrix so the whole CLASS of bug is impossible, not just the two
    /// instances already found — every mode, `.agent` with/without a role,
    /// provider/model set/unset, approvals on/off, and `sessionId`
    /// present/absent.
    ///
    /// `--effort` itself is no longer part of the matrix's DIMENSIONS — the
    /// app stopped sending it entirely (the owner configures reasoning effort
    /// at the provider level; see `ConversationController
    /// .persistentSessionArguments`'s doc) — but it stays a CONTENT assertion
    /// below: every combination in this matrix must produce an argv with no
    /// `--effort` anywhere in it, which is exactly the shape a regression
    /// (some future code path re-adding it) would break.
    ///
    /// For every combination this compares `plannedCommand(for:).arguments`
    /// against the value ACTUALLY used to spawn — never two literals that
    /// merely happen to match:
    ///
    /// - States that route through the persistent session (`.ask`, `.agent`
    ///   with no role) really do have two independent builders: the real spawn
    ///   (`submitToPersistentSession`) constructs its `PersistentSession` with
    ///   a SECOND, separate call to `persistentSessionArguments()`, not the
    ///   value the preview already computed. Comparing the two calls is the
    ///   genuine Bug-1-class guard.
    /// - One-shot states (`.compare`, `.race`, `.agent` WITH a role) have no
    ///   second builder to compare against — `submit()` hands
    ///   `dispatchOneShot` the exact `plannedCommand(for:)` result, so nothing
    ///   here could diverge from the preview by construction. Documenting
    ///   that honestly rather than writing a tautological assertion: this
    ///   branch instead asserts the ARGV CONTENT is correct for the state,
    ///   which is the only thing that can actually regress on that path.
    func testPreviewArgvMatchesTheActualSpawnAcrossTheFullStateMatrix() {
        let providerOptions: [String?] = [nil, "prov-x"]
        let modelOptions: [String?] = [nil, "model-x"]
        let approvalsOptions = [true, false]
        let sessionIdOptions: [String?] = [nil, "s_matrix"]
        // `.agent` is the only mode `role` affects — nil (native tool loop,
        // persistent) vs. set (OODA framework, one-shot) are two structurally
        // different dispatch shapes and both need a pass through the matrix;
        // every other mode only ever runs with role == nil.
        func roleOptions(for mode: RunMode) -> [String?] { mode == .agent ? [nil, "coder"] : [nil] }

        for mode in RunMode.allCases {
            for role in roleOptions(for: mode) {
                // Mirrors `ConversationController.usesPersistentSession`
                // (private to that type), computed here from PUBLIC state
                // only — the same duplication `ConversationView.approvalsApply`
                // already has to do, for the same reason: the controller
                // exposes what the property is computed FROM, not the
                // property itself.
                let usesPersistentSession = !mode.isMultiLane && !(mode == .agent && role != nil)

                for provider in providerOptions {
                    for model in modelOptions {
                        for approvalsEnabled in approvalsOptions {
                            for sessionId in sessionIdOptions {
                                let c = controller()
                                c.mode = mode
                                c.role = role
                                c.provider = provider
                                c.model = model
                                c.approvalsEnabled = approvalsEnabled
                                c.sessionId = sessionId
                                if mode.isMultiLane { c.backends = ["b1", "b2"] }

                                let context = "mode=\(mode.rawValue) role=\(role ?? "nil") " +
                                    "provider=\(provider ?? "nil") model=\(model ?? "nil") " +
                                    "approvals=\(approvalsEnabled) session=\(sessionId ?? "nil")"

                                let preview = c.plannedCommand(for: "matrix prompt").arguments

                                if usesPersistentSession {
                                    // The actual Bug-1 guard: a genuine second, independent call.
                                    XCTAssertEqual(
                                        preview, c.persistentSessionArguments(),
                                        "preview/spawn argv diverged for \(context)"
                                    )
                                    XCTAssertEqual(preview.first, "chat", context)
                                    XCTAssertTrue(preview.contains("--persistent"), context)
                                    // The persistent path never puts the prompt in argv — it is
                                    // written to the process's stdin turn by turn instead.
                                    XCTAssertFalse(preview.contains("matrix prompt"), "persistent path must never argv the prompt, \(context)")
                                } else {
                                    XCTAssertEqual(preview.first, mode.rawValue, context)
                                    XCTAssertTrue(preview.contains("matrix prompt"), "one-shot dispatch must argv the prompt, \(context)")
                                }

                                // --- Content assertions, shared by both dispatch shapes ---

                                // The app never sends `--effort`, in ANY state — see this
                                // test's doc.
                                XCTAssertFalse(preview.contains("--effort"), "--effort must never be sent, \(context)")

                                if usesPersistentSession {
                                    XCTAssertEqual(preview.contains("-t"), approvalsEnabled, context)
                                    XCTAssertEqual(preview.contains("--ask"), approvalsEnabled, context)
                                } else {
                                    // Documented, honest gap (pre-existing, not introduced by this
                                    // test): one-shot dispatch has no approval-gate flag at all
                                    // today — `oneShotArguments` never reads `approvalsEnabled` —
                                    // so compare/race/role-agent runs are never gated regardless of
                                    // this setting. Asserted explicitly so a silently-untested
                                    // combination can't hide a real gap the way this bug class has
                                    // twice before.
                                    XCTAssertFalse(preview.contains("-t"), context)
                                    XCTAssertFalse(preview.contains("--ask"), context)
                                }

                                if mode.isMultiLane {
                                    XCTAssertFalse(preview.contains("-p"), "compare/race must never carry -p/-m, \(context)")
                                    XCTAssertFalse(preview.contains("-m"), context)
                                } else {
                                    XCTAssertEqual(preview.contains("-p"), provider != nil, context)
                                    XCTAssertEqual(preview.contains("-m"), model != nil, context)
                                }

                                if mode == .agent, let role {
                                    XCTAssertTrue(preview.contains("--role") && preview.contains(role), context)
                                }
                                // `agent --role` DOES honor `--resume` (threaded through the same
                                // `resolveResumeTarget` resolver `chat --persistent` uses — see
                                // `oneShotArguments`'s doc) — so every mode, role or not, carries
                                // `--resume` exactly when `sessionId` is set. What resumes is the
                                // CONVERSATION only; plan/task state always starts fresh, but that's
                                // a runtime behavior, not a reason to withhold the flag from argv.
                                XCTAssertEqual(preview.contains("--resume"), sessionId != nil, context)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Role (Bug 2 / Bug 3)

    func testAgentWithNilRoleIsByteIdenticalToTodaysBehaviour() {
        let withRole = controller()
        withRole.mode = .agent
        withRole.provider = "anthropic"
        withRole.model = "claude-sonnet-4-5"
        withRole.role = nil

        let withoutRoleProperty = controller()
        withoutRoleProperty.mode = .agent
        withoutRoleProperty.provider = "anthropic"
        withoutRoleProperty.model = "claude-sonnet-4-5"

        // `role == nil` must produce the exact same argv as before this
        // property existed: the persistent `chat --persistent` invocation,
        // with no `--role` anywhere in it.
        let args = withRole.plannedCommand(for: "do it").arguments
        XCTAssertEqual(args, withoutRoleProperty.plannedCommand(for: "do it").arguments)
        XCTAssertFalse(args.contains("--role"))
        XCTAssertEqual(args.first, "chat")
    }

    func testAgentWithARoleInvokesTheRoleFlagAsAOneShotDispatch() {
        let c = controller()
        c.mode = .agent
        c.provider = "mock"
        c.model = "mock-tools"
        c.role = "coder"

        let args = c.plannedCommand(for: "fix the bug").arguments
        XCTAssertEqual(args.first, "agent")
        XCTAssertTrue(args.contains("fix the bug"))
        XCTAssertEqual(args.filter { $0 == "--role" }.count, 1)
        XCTAssertTrue(args.contains("--role") && args.contains("coder"))
        XCTAssertTrue(args.contains("-o") && args.contains("ndjson"))
        XCTAssertTrue(args.contains("-p") && args.contains("mock"))
        XCTAssertTrue(args.contains("-m") && args.contains("mock-tools"))
        // `nexus agent --role` has no `--persistent` mode — it is one-shot per
        // invocation, unlike `chat --persistent` — so a role run must dispatch
        // like `compare`/`race` do, never through the persistent session.
        XCTAssertFalse(args.contains("--persistent"))

        c.submit("fix the bug")
        // A role run is one-shot: it must never touch the persistent backend.
        XCTAssertNil(c.activeBackendProvider)
    }

    /// Was `testRoleRunsDoNotClaimResumeSupportTheCliDoesNotHave`, asserting
    /// the opposite of this. That was true when written; `runAgentOoda` now
    /// threads `--resume` through the same `resolveResumeTarget` resolver
    /// `chat --persistent` uses (`packages/cli/src/commands.ts`), with the
    /// worked example `nexus agent --role researcher --resume s_1234 …`
    /// documented at `packages/cli/src/index.ts`. Withholding the flag here
    /// meant every role run silently started from nothing.
    func testRoleRunsDoResumeTheConversationEvenThoughPlanStateAlwaysStartsFresh() {
        let c = controller()
        c.mode = .agent
        c.role = "reviewer"
        c.sessionId = "s_999"

        let args = c.plannedCommand(for: "review this").arguments
        XCTAssertTrue(args.contains("--resume") && args.contains("s_999"))
        XCTAssertTrue(args.contains("--role") && args.contains("reviewer"))
    }

    func testUnknownRoleStringIsPassedThroughUnmodified() {
        let c = controller()
        c.mode = .agent
        c.role = "totally-not-a-real-role"

        // Validation belongs to the CLI, which already returns a clear error;
        // duplicating a role allowlist here would be a stale copy waiting to
        // happen, exactly like the model picker.
        let args = c.plannedCommand(for: "x").arguments
        XCTAssertTrue(args.contains("--role") && args.contains("totally-not-a-real-role"))
    }

    /// Mirrors `testSwitchingProviderRelaunchesTheBackend`: a role change is
    /// exactly as spawn-affecting as a provider/model change, because setting
    /// a role moves the run off the persistent session entirely.
    func testSwitchingRoleRelaunchesTheBackend() {
        let c = controller()
        c.mode = .agent
        c.provider = "alpha"
        c.model = "alpha-1"
        // role == nil here: identical to `.ask`, runs the persistent session.
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        c.cancel()
        c.role = "coder"
        c.submit("second")

        // REGRESSION GUARD. Setting a role moves the run onto the one-shot
        // `agent --role` path. The stale role-less persistent backend must be
        // stopped rather than left running invisibly while a second, role-aware
        // process also starts — so the reported active backend must no longer
        // be the persistent one.
        XCTAssertNil(c.activeBackendProvider)
    }

    // MARK: - Submit guards

    func testFanOutRequiresAtLeastTwoBackends() {
        let c = controller()
        c.mode = .compare
        XCTAssertFalse(c.canSubmit, "comparing one backend is not a comparison")
        c.backends = ["only-one"]
        XCTAssertFalse(c.canSubmit)
        c.backends = ["one", "two"]
        XCTAssertTrue(c.canSubmit)
    }

    func testSingleLaneModesCanSubmitWithNoExplicitProvider() {
        let c = controller()
        c.mode = .ask
        // The CLI resolves its own default provider; the app must not require one.
        XCTAssertTrue(c.canSubmit)
    }

    func testClearResetsTheTranscriptDeterministically() {
        let c = controller()
        c.ingest([
            .prompt(.init(lane: "main", id: "p0", text: "hi")),
            .text(.init(lane: "main", delta: "answer")),
        ])
        XCTAssertFalse(c.view.lanes.isEmpty)

        c.clear()
        XCTAssertTrue(c.view.lanes.isEmpty)
        XCTAssertEqual(c.view.eventCount, 0)
        XCTAssertFalse(c.isRunning)
    }

    // MARK: - Resume / Replay (Sessions tab wiring)
    //
    // `reopen(sessionId:)` is the seam `SessionsView`'s Resume and Replay
    // buttons share (see that file). These cover the three things it
    // promises: the id sticks, a stale transcript doesn't linger, and a
    // still-live backend from a DIFFERENT conversation doesn't keep answering
    // underneath the newly-picked session.

    func testReopenPointsAtTheGivenSessionId() {
        let c = controller()
        c.reopen(sessionId: "s_42")
        XCTAssertEqual(c.sessionId, "s_42")
    }

    func testReopenClearsAnyExistingTranscript() {
        let c = controller()
        c.ingest([
            .prompt(.init(lane: "main", id: "p0", text: "hi")),
            .text(.init(lane: "main", delta: "answer")),
        ])
        XCTAssertFalse(c.view.lanes.isEmpty)

        c.reopen(sessionId: "s_42")
        XCTAssertTrue(c.view.lanes.isEmpty, "Resume/Replay must not show a stale transcript from whatever was open before")
    }

    func testReopenStopsALiveBackendSoTheNextSubmitStartsFreshAgainstTheNewSession() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        // Resuming a DIFFERENT session while this one is still live must not
        // leave the old process running underneath the newly-set sessionId —
        // otherwise the next message would silently keep talking to the old
        // conversation instead of the one the user just picked.
        c.reopen(sessionId: "s_other")
        XCTAssertNil(c.activeBackendProvider)
    }

    func testReopenedSessionIdCarriesResumeOnTheNextSubmit() {
        let c = controller()
        c.reopen(sessionId: "s_5")

        // Mirrors `testResumeIsThreadedSoFollowUpTurnsKeepContext` — this is
        // the whole point of Resume: the CLI restores the model's context via
        // `--resume`, not a replayed UI event log.
        let args = c.plannedCommand(for: "again").arguments
        XCTAssertTrue(args.contains("--resume"))
        XCTAssertTrue(args.contains("s_5"))
    }

    // Regression: a resumed conversation used to silently omit `-p`/`-m`
    // whenever this controller's picker hadn't already been populated —
    // which, on a fresh app run where Sessions → Resume is the user's FIRST
    // action, is the ordinary case, not an edge case (`ChatTab`'s auto-select
    // only fires once the Chat tab itself has rendered — see `RootView
    // .swift`). The resumed command then fell through to whatever the CLI
    // defaults to right now instead of the provider/model that conversation
    // was actually having — the exact "I don't have tools" class of report
    // this closes. `NexusSession` already carries the session's own
    // most-recent-run `provider`/`model` (`SessionMeta.provider`/`.model` on
    // the CLI side); `reopen` now takes them so a resumed session launches
    // with the SAME configuration a fresh one would, not a degraded one.
    func testReopenRestoresTheSessionsOwnProviderAndModelSoResumeCarriesFullConfiguration() {
        let c = controller()
        // Nothing has auto-selected a provider yet in this run — the exact
        // state a fresh app launch is in before `ChatTab` ever renders.
        XCTAssertNil(c.provider)
        XCTAssertNil(c.model)

        c.reopen(sessionId: "s_5", provider: "anthropic", model: "claude-opus-5")

        XCTAssertEqual(c.provider, "anthropic")
        XCTAssertEqual(c.model, "claude-opus-5")

        let args = c.plannedCommand(for: "again").arguments
        XCTAssertTrue(args.contains("-p") && args.contains("anthropic"))
        XCTAssertTrue(args.contains("-m") && args.contains("claude-opus-5"))
        // `-t --ask` are independent of provider/model — `approvalsEnabled`
        // defaults `true` and resume doesn't touch it — but assert it stays
        // that way here too, so a resumed session's tool loop matches a
        // fresh one's exactly, not just its backend selection.
        XCTAssertTrue(args.contains("-t") && args.contains("--ask"))
    }

    // A session recorded before provider/model tracking existed (or a
    // `Replay`/`Resume` invoked with incomplete metadata) reports `nil` for
    // one or both — that must not CLOBBER a value this controller already
    // has with `nil`. `provider ?? self.provider` is the merge policy, not a
    // flat overwrite.
    func testReopenWithNoRecordedProviderDoesNotClobberAnAlreadyChosenOne() {
        let c = controller()
        c.provider = "anthropic"
        c.model = "claude-opus-5"

        c.reopen(sessionId: "s_5")

        XCTAssertEqual(c.provider, "anthropic")
        XCTAssertEqual(c.model, "claude-opus-5")
    }

    // MARK: - Provider switching (regression)
    //
    // History: this used to assert a provider/model change on a live session
    // RELAUNCHES the backend (tear down, respawn, `--resume`) — the fix, at
    // the time, for the picker claiming one provider while a stale process
    // kept answering from another. That relaunch is now itself superseded:
    // `nexus chat --persistent` accepts an in-process `{"type":"switch",…}`
    // control line, so the SAME live process can retarget without ever being
    // torn down. `testProviderChangeOnALiveSessionSendsASwitchControlLineRatherThanTearingDownTheSession`
    // below is the current regression guard for the underlying defect (a
    // picker that lies about what's serving); relaunching is now reserved
    // for the cases a control line genuinely cannot cover — see
    // `testSwitchingRoleRelaunchesTheBackend` and
    // `testNoLiveSessionYetStillLaunchesDirectlyWithTheCurrentSelection`.

    func testProviderChangeOnALiveSessionSendsASwitchControlLineRatherThanTearingDownTheSession() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.model = "alpha-1"

        c.submit("first")
        // The backend is spawned with `-p alpha` baked into argv.
        XCTAssertEqual(c.activeBackendProvider, "alpha")
        XCTAssertEqual(c.activeBackendModel, "alpha-1")

        // Settle the turn WITHOUT ending the session — `cancel()` frees the
        // composer but deliberately leaves the backend alive, which is exactly
        // the state a real user switches provider in.
        c.cancel()

        // The user picks a different provider and sends again.
        c.provider = "beta"
        c.model = "beta-1"
        c.submit("second")

        // REGRESSION GUARD (current). Unlike the old relaunch behavior, a
        // provider/model change on an already-live persistent session must
        // NOT tear the process down: `submit()` only calls `stopLiveSession`
        // for a ROLE change now (see the MARK comment above). If this had
        // relaunched, `activeBackendProvider`/`activeBackendModel` would
        // already read "beta"/"beta-1" — `submitToPersistentSession`
        // assigns `launchedWith` SYNCHRONOUSLY, before any await, the moment
        // it spawns a fresh process (see `testSwitchingProviderRelaunchesTheBackend`'s
        // prior version, which asserted exactly that transition). Reading
        // "alpha"/"alpha-1" here instead proves no relaunch occurred — the
        // real backend is still the one from "first", now waiting on a
        // `switch` control line to actually retarget it (verified end to
        // end, including the retarget itself, in `SwitchWiringTests`).
        XCTAssertEqual(c.activeBackendProvider, "alpha")
        XCTAssertEqual(c.activeBackendModel, "alpha-1")
    }

    /// A role change is a different kind of change than provider/model: it
    /// moves the run onto `nexus agent --role`, which has no `--persistent`
    /// mode at all (see `usesPersistentSession`) — no control line could ever
    /// cover it, so it must keep relaunching even when a provider/model
    /// change rides along with it in the same picker update.
    func testRoleChangeStillRelaunchesEvenAlongsideAProviderChange() {
        let c = controller()
        c.mode = .agent
        c.provider = "alpha"
        c.model = "alpha-1"
        // role == nil here: identical to `.ask`, runs the persistent session.
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        c.cancel()
        c.provider = "beta"
        c.model = "beta-1"
        c.role = "coder"
        c.submit("second")

        // A role change moved this off the persistent session entirely —
        // must never look like a live in-process switch.
        XCTAssertNil(c.activeBackendProvider)
    }

    /// The other explicit carve-out: with no live session yet, there is
    /// nothing to switch IN — the very first launch just bakes the current
    /// selection into argv, same as always.
    func testNoLiveSessionYetStillLaunchesDirectlyWithTheCurrentSelection() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.model = "alpha-1"

        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")
        XCTAssertEqual(c.activeBackendModel, "alpha-1")
    }

    // MARK: - Switch control line

    func testSwitchControlLineMatchesTheCLIsWireFormat() {
        // Exact shape `parseSwitchDecision` requires (`packages/cli/src/commands.ts`):
        // `{"type":"switch","provider":"…"}`, with `model` present only when set.
        let withModel = SwitchRequest(provider: "codex", model: "gpt-5")
        XCTAssertEqual(withModel.controlLine, "{\"type\":\"switch\",\"provider\":\"codex\",\"model\":\"gpt-5\"}")

        let withoutModel = SwitchRequest(provider: "codex", model: nil)
        XCTAssertEqual(withoutModel.controlLine, "{\"type\":\"switch\",\"provider\":\"codex\"}")
    }

    func testSwitchControlLineEscapesQuotesAndBackslashes() {
        let request = SwitchRequest(provider: "weird\"provider\\", model: nil)
        XCTAssertEqual(request.controlLine, "{\"type\":\"switch\",\"provider\":\"weird\\\"provider\\\\\"}")
    }

    // MARK: - Switch reconciliation (`absorb`'s `.switch` handling)
    //
    // `absorb` is the seam that actually reacts to a real `switch` UiEvent —
    // exercised here directly (it is non-`private` for exactly this reason,
    // same as `persistentSessionArguments()`) so these stay fast, synchronous
    // unit tests rather than needing a real spawned backend. `SwitchWiringTests`
    // covers the same behavior end to end against the real CLI.

    private func switchEvent(
        from: (String, String) = ("alpha", "alpha-1"),
        to: (String, String),
        accepted: Bool,
        blockers: [String] = []
    ) -> UiEvent {
        .switch(.init(
            lane: "main",
            from: .init(providerId: from.0, modelId: from.1),
            to: .init(providerId: to.0, modelId: to.1),
            accepted: accepted,
            blockers: blockers,
            warnings: [],
            preserved: accepted ? ["conversation transcript"] : [],
            adaptations: [],
            reason: "explicit switch requested by client"
        ))
    }

    func testAcceptedSwitchEventUpdatesLaunchedWithAndThePickerToTheResolvedTarget() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.model = "alpha-1"
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        // The picker moved on to a target the CLI resolved to a DIFFERENT
        // model than requested (e.g. `model` was left nil for the CLI's own
        // default) — the picker must land on what actually happened, not
        // what was merely asked for.
        c.provider = "beta"
        c.model = nil
        c.absorb(.event(switchEvent(to: ("beta", "beta-resolved"), accepted: true)))

        XCTAssertEqual(c.activeBackendProvider, "beta")
        XCTAssertEqual(c.activeBackendModel, "beta-resolved")
        XCTAssertEqual(c.provider, "beta")
        XCTAssertEqual(c.model, "beta-resolved")
    }

    func testRefusedSwitchEventRevertsThePickerButLeavesTheLiveBackendAlone() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"
        c.model = "alpha-1"
        c.submit("first")
        XCTAssertEqual(c.activeBackendProvider, "alpha")

        // The user picked an unusable target — mirrors the real dropdown,
        // which clears `model` the instant `provider` changes.
        c.provider = "definitely-not-a-provider"
        c.model = nil
        c.absorb(.event(switchEvent(
            to: ("definitely-not-a-provider", ""),
            accepted: false,
            blockers: ["\"definitely-not-a-provider\" is not available (no usable credential)"]
        )))

        // REGRESSION GUARD. The live backend never moved — `launchedWith`
        // was never touched for this path (no relaunch happened) — so the
        // PICKER must revert to match it. Leaving `provider`/`model` on the
        // refused target is exactly the "picker claims a provider that
        // isn't serving" bug this whole feature exists to close, just
        // reached through the switch path instead of the original relaunch
        // path.
        XCTAssertEqual(c.provider, "alpha")
        XCTAssertEqual(c.model, "alpha-1")
        XCTAssertEqual(c.activeBackendProvider, "alpha")
        XCTAssertEqual(c.activeBackendModel, "alpha-1")
    }

    func testSameProviderDoesNotRelaunchTheBackend() {
        let c = controller()
        c.mode = .ask
        c.provider = "alpha"

        c.submit("first")
        let before = c.activeBackendProvider
        c.cancel()
        c.submit("second")

        // Restarting on every turn would throw away the conversation's process
        // (and its warm state) for nothing — only a CHANGE justifies it.
        XCTAssertEqual(c.activeBackendProvider, before)
    }

    func testFanOutModesDoNotTouchThePersistentBackend() {
        let c = controller()
        c.mode = .compare
        c.backends = ["one", "two"]
        c.submit("compare this")

        // compare/race are one-shot dispatches, not a held conversation, so they
        // must never spawn or disturb the persistent session.
        XCTAssertNil(c.activeBackendProvider)
    }

    // MARK: - Agent rows

    func testLaneRowsReportStreamingAndToolCounts() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "anthropic", id: "p", text: "x")), ts: 0)
        state.reduce(.toolCall(.init(lane: "anthropic", id: "c1", name: "bash", args: nil)), ts: 1)
        state.reduce(.prompt(.init(lane: "openai", id: "p", text: "x")), ts: 2)
        state.reduce(.done(.init(lane: "openai", finishReason: "stop")), ts: 3)

        let rows = AgentRowBuilder.lanes(from: state)
        XCTAssertEqual(rows.count, 2)

        let anthropic = try XCTUnwrap(rows.first { $0.title == "anthropic" })
        XCTAssertTrue(anthropic.isRunning)
        XCTAssertEqual(anthropic.detail, "1 tool call")
        XCTAssertEqual(anthropic.origin, .lane)

        let openai = try XCTUnwrap(rows.first { $0.title == "openai" })
        XCTAssertFalse(openai.isRunning)
        XCTAssertEqual(openai.subtitle, "finished · stop")
    }

    /// The Agents screen's disclosure control reads real tool-call data off
    /// the row, not a re-derived count — this is what makes "expand this
    /// card" honest rather than decorative.
    func testLaneRowCarriesItsToolCallsForExpansion() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "anthropic", id: "p", text: "x")), ts: 0)
        state.reduce(.toolCall(.init(lane: "anthropic", id: "c1", name: "bash", args: nil)), ts: 1)
        state.reduce(.toolCall(.init(lane: "anthropic", id: "c2", name: "read_file", args: nil)), ts: 2)

        let row = try XCTUnwrap(AgentRowBuilder.lanes(from: state).first { $0.title == "anthropic" })
        XCTAssertEqual(row.toolCalls.map(\.name), ["bash", "read_file"])
        XCTAssertTrue(row.hasExpandableDetail)
    }

    func testLaneRowWithNoToolCallsHasNothingToExpand() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "plain", id: "p", text: "x")), ts: 0)
        state.reduce(.text(.init(lane: "plain", delta: "hi")), ts: 1)

        let row = try XCTUnwrap(AgentRowBuilder.lanes(from: state).first)
        XCTAssertTrue(row.toolCalls.isEmpty)
        XCTAssertFalse(row.hasExpandableDetail, "a lane with nothing to show must not offer a disclosure control")
    }

    func testLaneRowSurfacesFailure() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "gemini", id: "p", text: "x")), ts: 0)
        state.reduce(.error(.init(lane: "gemini", code: "auth", message: "no key", retryable: false)), ts: 1)

        let row = try XCTUnwrap(AgentRowBuilder.lanes(from: state).first)
        XCTAssertTrue(row.isFailed)
    }

    func testCombinedListSortsRunningAgentsFirst() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "busy", id: "p", text: "x")), ts: 0)
        state.reduce(.prompt(.init(lane: "idle", id: "p", text: "x")), ts: 1)
        state.reduce(.done(.init(lane: "idle", finishReason: "stop")), ts: 2)

        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(
                agentId: "a1", agentType: "executor",
                startedAt: Date(timeIntervalSince1970: 100), completedAt: nil, status: .running
            ),
            OMCAgent(
                agentId: "a2", agentType: "verifier",
                startedAt: Date(timeIntervalSince1970: 50),
                completedAt: Date(timeIntervalSince1970: 60), status: .completed
            ),
        ])

        let rows = AgentRowBuilder.combined(state: state, snapshot: snapshot)
        // Everything working sorts above everything finished, whatever its origin.
        let runningPrefix = rows.prefix { $0.isRunning }
        XCTAssertEqual(runningPrefix.count, 2)
        XCTAssertTrue(runningPrefix.contains { $0.origin == .lane })
        XCTAssertTrue(runningPrefix.contains { $0.origin == .omc })
    }

    func testOmcRowsExcludePhantomAgents() {
        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(
                agentId: "real", agentType: "explore",
                startedAt: Date(), completedAt: nil, status: .running
            ),
            OMCAgent(
                agentId: "ghost", agentType: "untracked-native-fork",
                startedAt: Date(), completedAt: Date(), status: .completed, synthetic: true
            ),
        ])
        let rows = AgentRowBuilder.omcAgents(from: snapshot)
        XCTAssertEqual(rows.map(\.title), ["explore"])
    }

    /// A real, two-agent mission timeline (shape taken from `omc-mission.json`):
    /// each row's `timeline` must contain only ITS OWN events, newest first —
    /// the other agent's events must never leak in just because they share a
    /// mission file.
    private func twoAgentMissionState() throws -> OMCMissionState {
        let raw = """
        {
          "missions": [{
            "id": "m1", "name": "session", "objective": "do the thing", "status": "running",
            "workerCount": 2,
            "taskCounts": {"total": 2, "pending": 0, "blocked": 0, "inProgress": 1, "completed": 1, "failed": 0},
            "agents": [
              {"name": "nexus-surface:a1", "role": "nexus-surface", "ownership": "agent-a", "status": "running"},
              {"name": "omc-surface:a2", "role": "omc-surface", "ownership": "agent-b", "status": "done"}
            ],
            "timeline": [
              {"id": "e1", "at": "2026-07-26T17:54:34.000Z", "kind": "completion", "agent": "nexus-surface:a1", "detail": "completed"},
              {"id": "e2", "at": "2026-07-26T17:54:44.000Z", "kind": "completion", "agent": "omc-surface:a2", "detail": "completed"},
              {"id": "e3", "at": "2026-07-26T18:03:42.000Z", "kind": "update", "agent": "nexus-surface:a1", "detail": "started again"}
            ]
          }]
        }
        """
        return try JSONDecoder().decode(OMCMissionState.self, from: Data(raw.utf8))
    }

    func testOmcRowCarriesOnlyItsOwnMissionTimelineSliceNewestFirst() throws {
        var snapshot = OMCSnapshot()
        snapshot.missions = try twoAgentMissionState()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(agentId: "agent-a", agentType: "nexus-surface", startedAt: Date(), completedAt: nil, status: .running),
        ])

        let row = try XCTUnwrap(AgentRowBuilder.omcAgents(from: snapshot).first)
        // Two of the three timeline events belong to this agent; the third
        // (agent-b's) must not appear.
        XCTAssertEqual(row.timeline.map(\.id), ["e3", "e1"], "must be this agent's own events only, newest first")
        XCTAssertTrue(row.hasExpandableDetail)
    }

    func testOmcRowOutsideAnyTrackedMissionHasNoTimelineAndNothingToExpand() throws {
        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(agentId: "lone", agentType: "explore", startedAt: Date(), completedAt: nil, status: .running),
        ])
        // `snapshot.missions` deliberately left nil — a real, common case
        // (agents/OMC subagent tracking runs even when the mission file
        // doesn't exist yet, e.g. before the first delegation).

        let row = try XCTUnwrap(AgentRowBuilder.omcAgents(from: snapshot).first)
        XCTAssertTrue(row.timeline.isEmpty)
        XCTAssertFalse(row.hasExpandableDetail, "an OMC agent outside any tracked mission must not offer a disclosure control")
    }

    // MARK: - Role runs (`nexus agent --role …`)

    private func agentStep(
        lane: String = "main", _ phase: String, step: Int = 0, role: String = "coder", data: JSONValue? = nil
    ) -> UiEvent {
        .agent(.init(lane: lane, phase: phase, role: role, step: step, text: "narration", data: data))
    }

    func testRoleRunRowExposesRolePhaseStepAndProgress() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "build the thing")), ts: 0)
        state.reduce(agentStep("step-start", step: 0, role: "coder"), ts: 1)
        state.reduce(agentStep("delegate", step: 1, role: "coder", data: .object(["role": .string("reviewer")])), ts: 2)
        state.reduce(agentStep("progress", step: 1, role: "coder", data: .object(["percent": .number(40)])), ts: 3)

        let row = try XCTUnwrap(AgentRowBuilder.roleRuns(from: state).first)
        XCTAssertEqual(row.origin, .roleRun)
        XCTAssertEqual(row.title, "coder")
        XCTAssertTrue(row.isRunning)
        XCTAssertNil(row.verdict, "still running -> no verdict yet")
        XCTAssertEqual(row.subtitle, "progress · step 1")
        XCTAssertEqual(row.detail, "40% progress · delegated: reviewer")
    }

    /// Same guarantee as the lane row above, for the OODA loop's own step
    /// history — real `AgentStep`s off the turn, not a re-summarized copy.
    func testRoleRunRowCarriesItsStepHistoryForExpansion() throws {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "build the thing")), ts: 0)
        state.reduce(agentStep("step-start", step: 0, role: "coder"), ts: 1)
        state.reduce(agentStep("plan", step: 0, role: "coder"), ts: 2)
        state.reduce(agentStep("progress", step: 1, role: "coder", data: .object(["percent": .number(40)])), ts: 3)

        let row = try XCTUnwrap(AgentRowBuilder.roleRuns(from: state).first)
        XCTAssertEqual(row.steps.map(\.phase), ["step-start", "plan", "progress"])
        XCTAssertTrue(row.hasExpandableDetail)
        // A role run without at least one step never reaches `roleRuns(from:)`
        // at all (`turn.isAgentRun` guards on a non-empty `agentSteps`), so
        // there is no "role run with nothing to expand" case to cover here —
        // unlike a lane, which can legitimately have zero tool calls.
    }

    func testRoleRunDoesNotAlsoAppearAsAPlainLaneRow() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
        state.reduce(agentStep("plan"), ts: 1)

        let rows = AgentRowBuilder.combined(state: state, snapshot: OMCSnapshot())
        XCTAssertTrue(rows.contains { $0.origin == .roleRun })
        XCTAssertFalse(rows.contains { $0.origin == .lane }, "a role run's lane must not double-count as a plain lane row")
        XCTAssertTrue(AgentRowBuilder.lanesExcludingRoleRuns(from: state).isEmpty)
    }

    func testAnOrdinaryChatTurnProducesNoRoleRunRow() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "main", id: "p", text: "hi")), ts: 0)
        state.reduce(.text(.init(lane: "main", delta: "hello")), ts: 1)

        XCTAssertTrue(AgentRowBuilder.roleRuns(from: state).isEmpty)
        // An ordinary chat turn keeps rendering as a plain lane, unaffected.
        XCTAssertEqual(AgentRowBuilder.lanesExcludingRoleRuns(from: state).map(\.origin), [.lane])
    }

    func testFourVerdictStatesMapToFourVisiblyDistinctRowStates() throws {
        func finishedRow(_ verdictData: JSONValue) throws -> AgentRow {
            var state = ViewState()
            state.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
            state.reduce(agentStep("stop", step: 1, data: verdictData), ts: 1)
            state.reduce(.done(.init(lane: "main", finishReason: "stop")), ts: 2)
            return try XCTUnwrap(AgentRowBuilder.roleRuns(from: state).first)
        }

        var running = ViewState()
        running.reduce(.prompt(.init(lane: "main", id: "p", text: "go")), ts: 0)
        running.reduce(agentStep("plan"), ts: 1)
        let runningRow = try XCTUnwrap(AgentRowBuilder.roleRuns(from: running).first)

        let metRow = try finishedRow(.object(["stopReason": .string("goal-met"), "verdict": .string("met")]))
        let unmetRow = try finishedRow(.object(["stopReason": .string("goal-unmet"), "verdict": .string("unmet")]))
        // No declared success criteria -> nothing to verify against. This is
        // the honest "we don't know" outcome, not a crash and not a soft fail.
        let indeterminateRow = try finishedRow(.object(["stopReason": .string("max-steps")]))

        XCTAssertTrue(runningRow.isRunning)
        XCTAssertNil(runningRow.verdict)

        XCTAssertFalse(metRow.isRunning)
        XCTAssertEqual(metRow.verdict, .met)

        XCTAssertFalse(unmetRow.isRunning)
        XCTAssertEqual(unmetRow.verdict, .unmet)

        XCTAssertFalse(indeterminateRow.isRunning)
        XCTAssertEqual(indeterminateRow.verdict, .indeterminate)

        // The assertion that matters most: an unverified run must never read
        // as either a success or a failure.
        XCTAssertNotEqual(indeterminateRow.verdict, metRow.verdict)
        XCTAssertNotEqual(indeterminateRow.verdict, unmetRow.verdict)

        // Running + the three verdicts are four pairwise-distinct signatures —
        // exactly the four states the card must render differently.
        let signatures = [runningRow, metRow, unmetRow, indeterminateRow].map {
            "\($0.isRunning)-\($0.verdict?.rawValue ?? "running")"
        }
        XCTAssertEqual(Set(signatures).count, 4)
    }

    func testCombinedStillReturnsLanesAndOmcAgentsExactlyAsBeforeWhenNoRoleRunIsPresent() {
        var state = ViewState()
        state.reduce(.prompt(.init(lane: "anthropic", id: "p", text: "x")), ts: 0)
        state.reduce(.prompt(.init(lane: "openai", id: "p", text: "x")), ts: 1)
        state.reduce(.done(.init(lane: "openai", finishReason: "stop")), ts: 2)

        var snapshot = OMCSnapshot()
        snapshot.registry = OMCAgentRegistry(agents: [
            OMCAgent(agentId: "a1", agentType: "executor", startedAt: Date(), completedAt: nil, status: .running),
        ])

        let rows = AgentRowBuilder.combined(state: state, snapshot: snapshot)
        XCTAssertEqual(Set(rows.map(\.origin)), [.lane, .omc])
        XCTAssertEqual(rows.filter { $0.origin == .lane }.count, 2)
        XCTAssertEqual(rows.filter { $0.origin == .omc }.count, 1)
    }

    // MARK: - Modes

    func testOnlyFanOutModesAreMultiLane() {
        XCTAssertFalse(RunMode.ask.isMultiLane)
        XCTAssertFalse(RunMode.agent.isMultiLane)
        XCTAssertTrue(RunMode.compare.isMultiLane)
        XCTAssertTrue(RunMode.race.isMultiLane)
    }

    func testEveryTabBelongsToExactlyOneGroupAndNoneAreOrphaned() {
        // A tab added later but left out of `group`'s switch would vanish from
        // the sidebar entirely — the switch is exhaustive so that cannot
        // compile, but this also guards the reverse: a group with no tabs would
        // render an empty header.
        let grouped = WorkspaceTab.Group.allCases.flatMap { WorkspaceTab.tabs(in: $0) }
        XCTAssertEqual(Set(grouped), Set(WorkspaceTab.allCases))
        XCTAssertEqual(grouped.count, WorkspaceTab.allCases.count, "a tab appears in two groups")
        for group in WorkspaceTab.Group.allCases {
            XCTAssertFalse(WorkspaceTab.tabs(in: group).isEmpty, "\(group) renders an empty header")
        }
    }

    func testEveryTabHasAnIconAndTitle() {
        for tab in WorkspaceTab.allCases {
            XCTAssertFalse(tab.title.isEmpty)
            XCTAssertFalse(tab.systemImage.isEmpty)
        }
    }

    // MARK: - OMC controller

    func testOMCControllerReportsUnavailableForANonOMCProject() {
        let controller = OMCController(workspace: nil)
        XCTAssertFalse(controller.isAvailable)
        XCTAssertTrue(controller.snapshot.isEmpty)
        // Starting a watch on a project without OMC must be a no-op, not a crash.
        controller.start()
        XCTAssertFalse(controller.isWatching)
    }
}
