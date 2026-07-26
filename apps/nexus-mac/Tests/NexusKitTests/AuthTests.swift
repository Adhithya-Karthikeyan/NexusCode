import XCTest
@testable import NexusKit

/// `ProviderAuth`/`AuthKind` decode straight from the `JSONValue`
/// `NexusClient.runJSON` hands back — driven by a fixture shaped exactly like
/// `nexus auth status -o json`, covering every `kind`, both `loggedIn`
/// states, missing optional fields, an unrecognized `kind` string, and a row
/// too malformed to display (no `providerId`) — mirroring `SessionsTests`'
/// own style for the same reasons.
///
/// The `AuthController` tests below never touch a real provider or a real
/// secret: every fake `nexus` is a tiny shell script, and the one real
/// secret-bearing test (`testSignInWithKeyWritesTheSecretToStdinNeverToArgv`)
/// proves the value lands in a captured STDIN file, not in the command's
/// `arguments` — the property the whole feature is built around.
final class AuthTests: XCTestCase {
    private func fixtureURL(_ name: String) throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json"))
    }

    private func fixtureJSON(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: try fixtureURL(name)))
    }

    // MARK: - AuthKind

    func testAuthKindDecodesEveryKnownWireString() {
        XCTAssertEqual(AuthKind(wire: "oauth"), .oauth)
        XCTAssertEqual(AuthKind(wire: "api-key"), .apiKey)
        XCTAssertEqual(AuthKind(wire: "cli-delegate"), .cliDelegate)
        XCTAssertEqual(AuthKind(wire: "cloud-sso"), .cloudSso)
    }

    func testAuthKindDegradesAnUnrecognizedOrMissingStringToUnknownRatherThanFailing() {
        XCTAssertEqual(AuthKind(wire: "quantum-sso"), .unknown)
        XCTAssertEqual(AuthKind(wire: nil), .unknown)
    }

    // MARK: - ProviderAuth decode

    func testDecodesANormalOAuthRowWithAllFields() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        let providers = items.compactMap(ProviderAuth.init(json:))

        let anthropic = try XCTUnwrap(providers.first { $0.providerId == "anthropic" })
        XCTAssertEqual(anthropic.kind, .oauth)
        XCTAssertTrue(anthropic.loggedIn)
        XCTAssertEqual(anthropic.method, "oauth (Claude account)")
        XCTAssertEqual(anthropic.detail, "token valid for ~4h")
        XCTAssertEqual(anthropic.expiresIn, "~4h")
    }

    func testDecodesEachOtherKnownKind() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        let providers = items.compactMap(ProviderAuth.init(json:))

        XCTAssertEqual(providers.first { $0.providerId == "openai" }?.kind, .apiKey)
        XCTAssertEqual(providers.first { $0.providerId == "claude-code" }?.kind, .cliDelegate)
        XCTAssertEqual(providers.first { $0.providerId == "bedrock" }?.kind, .cloudSso)
        XCTAssertEqual(providers.first { $0.providerId == "gemini" }?.kind, .cloudSso)
    }

    func testLoggedInFalseIsDecodedNotJustDefaulted() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        let providers = items.compactMap(ProviderAuth.init(json:))

        let openai = try XCTUnwrap(providers.first { $0.providerId == "openai" })
        XCTAssertFalse(openai.loggedIn)
        XCTAssertEqual(openai.detail, "no key (set OPENAI_API_KEY or run login)")
    }

    func testMissingOptionalFieldsDegradeToNilRatherThanCrashingTheDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        let providers = items.compactMap(ProviderAuth.init(json:))

        let groq = try XCTUnwrap(providers.first { $0.providerId == "groq" })
        XCTAssertEqual(groq.kind, .apiKey)
        XCTAssertFalse(groq.loggedIn)
        XCTAssertNil(groq.detail)
        XCTAssertNil(groq.expiresIn)
    }

    func testAnUnrecognizedKindStringDecodesToUnknownRatherThanDroppingTheRow() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        let providers = items.compactMap(ProviderAuth.init(json:))

        let mystery = try XCTUnwrap(providers.first { $0.providerId == "mystery-vendor" })
        XCTAssertEqual(mystery.kind, .unknown)
    }

    func testRowsWithNoProviderIdAreDroppedRatherThanCrashingTheWholeDecode() throws {
        let items = try XCTUnwrap(try fixtureJSON("auth-status").arrayValue)
        XCTAssertEqual(items.count, 8, "fixture shape changed")

        let providers = items.compactMap(ProviderAuth.init(json:))
        XCTAssertEqual(providers.count, 7, "the row without providerId must be dropped, not fail the array")
    }

    func testEmptyArrayProducesAnEmptyListNotAFailure() {
        XCTAssertTrue([JSONValue]().compactMap(ProviderAuth.init(json:)).isEmpty)
    }

    // MARK: - Command factories

    func testAuthStatusBuildsAJsonCommand() {
        XCTAssertEqual(NexusCommand.authStatus().arguments, ["auth", "status", "-o", "json"])
    }

    func testLoginBuildsAPlainCommandNotAJsonOne() {
        // A real login is a long-lived, interactive process — never routed
        // through `-o json` the way the other auth commands are.
        XCTAssertEqual(NexusCommand.login(provider: "anthropic").arguments, ["login", "anthropic"])
    }

    func testLogoutBuildsAPlainCommand() {
        XCTAssertEqual(NexusCommand.logout(provider: "openai").arguments, ["logout", "openai"])
    }

    func testLogoutAllBuildsAPlainCommand() {
        XCTAssertEqual(NexusCommand.logoutAll().arguments, ["logout", "--all"])
    }

    func testKeysSetBuildsAStdinCommandAndNeverPlacesASecretInArguments() {
        let command = NexusCommand.keysSet(ref: "openai")
        XCTAssertEqual(command.arguments, ["keys", "set", "openai", "--stdin"])
        // There is no secret parameter on this builder at all — this asserts
        // the intent explicitly rather than relying on the signature alone.
        XCTAssertFalse(command.arguments.contains { $0.contains("sk-") })
    }

    func testWorkingDirectoryThreadsThroughEveryCommandFactory() {
        let cwd = URL(fileURLWithPath: "/tmp")
        XCTAssertEqual(NexusCommand.authStatus(cwd: cwd).workingDirectory, cwd)
        XCTAssertEqual(NexusCommand.login(provider: "anthropic", cwd: cwd).workingDirectory, cwd)
        XCTAssertEqual(NexusCommand.logout(provider: "openai", cwd: cwd).workingDirectory, cwd)
        XCTAssertEqual(NexusCommand.logoutAll(cwd: cwd).workingDirectory, cwd)
        XCTAssertEqual(NexusCommand.keysSet(ref: "openai", cwd: cwd).workingDirectory, cwd)
    }

    // MARK: - AuthController, against fake `nexus` shell scripts
    //
    // Tiny shell scripts stand in for the real CLI so these stay hermetic (no
    // dependency on a built `nexus`), while still exercising the real
    // `Process`/pipe plumbing `AuthController` was added on top of — same
    // rationale as `SessionsTests`' own fake binaries.

    private func fixtureText(_ name: String) throws -> String {
        try String(contentsOf: try fixtureURL(name), encoding: .utf8)
    }

    /// A fake `nexus` that branches on its first argument: `auth` prints
    /// `statusJSON`, `keys` captures whatever is piped to its stdin into
    /// `captureURL` (when given) and prints a plain-text confirmation,
    /// `logout` prints plain text, and `login` prints a URL-ish line to
    /// stderr, blocks on a stdin line (simulating Anthropic's manual-code
    /// wait), then echoes what it read.
    private func fakeAuthBinary(statusJSON: String = "[]", captureKeyStdinTo captureURL: URL? = nil) throws -> NexusBinary {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-auth-\(UUID().uuidString)")
        let capturePath = captureURL?.path ?? "/dev/null"
        let contents = """
        #!/bin/sh
        case "$1" in
          auth)
            cat <<'NEXUS_FIXTURE_EOF'
        \(statusJSON)
        NEXUS_FIXTURE_EOF
            ;;
          keys)
            cat > "\(capturePath)"
            echo "saved key for $3 (file) - redacted"
            ;;
          logout)
            echo "logged out of ${2:-all}"
            ;;
          login)
            echo "Open this URL: https://example.com/authorize" >&2
            read code
            echo "got: ${code:-<none>}"
            ;;
          *)
            echo "unhandled $1" >&2
            exit 1
            ;;
        esac
        exit 0
        """
        try contents.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return NexusBinary(url: script)
    }

    private func fakeNexusBinary(printing output: String, exitCode: Int32 = 0) throws -> NexusBinary {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-nexus-\(UUID().uuidString)")
        let contents = """
        #!/bin/sh
        cat <<'NEXUS_FIXTURE_EOF'
        \(output)
        NEXUS_FIXTURE_EOF
        exit \(exitCode)
        """
        try contents.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return NexusBinary(url: script)
    }

    @MainActor
    func testRefreshPopulatesProvidersAndGroupsSignedInVsAvailable() async throws {
        let binary = try fakeAuthBinary(statusJSON: try fixtureText("auth-status"))
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        await controller.refresh()

        XCTAssertNil(controller.error)
        XCTAssertFalse(controller.isLoading)
        XCTAssertEqual(controller.providers.count, 7, "the malformed row must be dropped")
        XCTAssertTrue(controller.signedIn.allSatisfy(\.loggedIn))
        XCTAssertTrue(controller.available.allSatisfy { !$0.loggedIn })
        XCTAssertTrue(controller.signedIn.contains { $0.providerId == "anthropic" })
        XCTAssertTrue(controller.available.contains { $0.providerId == "openai" })
    }

    @MainActor
    func testRefreshSurfacesMalformedJSONAsItsErrorRatherThanCrashing() async throws {
        let binary = try fakeNexusBinary(printing: "this is not { json")
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        await controller.refresh()

        XCTAssertTrue(controller.providers.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testSignInWithKeyWritesTheSecretToStdinNeverToArgv() async throws {
        let captureURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("captured-key-\(UUID().uuidString).txt")
        let binary = try fakeAuthBinary(captureKeyStdinTo: captureURL)
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let secret = "sk-ant-supersecretvalue9999"
        let command = NexusCommand.keysSet(ref: "openai")
        // The command handed to the process never carries the secret...
        XCTAssertFalse(command.arguments.contains(secret))

        let ok = await controller.signInWithKey(provider: "openai", key: secret)
        XCTAssertTrue(ok)

        // ...it arrived at the child exclusively via stdin.
        let captured = try String(contentsOf: captureURL, encoding: .utf8)
        XCTAssertEqual(captured.trimmingCharacters(in: .whitespacesAndNewlines), secret)
    }

    @MainActor
    func testSignInWithKeyFailureSurfacesTheExitCodeAsAnError() async throws {
        let binary = try fakeNexusBinary(printing: "nope", exitCode: 1)
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let ok = await controller.signInWithKey(provider: "openai", key: "sk-ant-whatever0000")
        XCTAssertFalse(ok)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testSignOutTreatsPlainTextExitZeroAsSuccessNotMalformedJSON() async throws {
        // `logout` prints plain text on success (never JSON) — this is
        // exactly why `AuthController` cannot run it through
        // `NexusClient.runJSON` (which would call this `.malformedJSON`, a
        // false failure, on the very success case being tested here).
        let binary = try fakeAuthBinary()
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let ok = await controller.signOut(provider: "openai")
        XCTAssertTrue(ok)
        XCTAssertNil(controller.error)
    }

    @MainActor
    func testSignOutAllTreatsPlainTextExitZeroAsSuccess() async throws {
        let binary = try fakeAuthBinary()
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let ok = await controller.signOutAll()
        XCTAssertTrue(ok)
        XCTAssertNil(controller.error)
    }

    @MainActor
    func testSignOutSurfacesANonZeroExitAsFailure() async throws {
        let binary = try fakeNexusBinary(printing: "boom", exitCode: 1)
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let ok = await controller.signOut(provider: "openai")
        XCTAssertFalse(ok)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testSignInStreamsProgressAndSubmitCodeUnblocksTheWaitingProcess() async throws {
        let binary = try fakeAuthBinary()
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let stream = await controller.signIn(provider: "demo")
        XCTAssertTrue(controller.isSigningIn("demo"), "must be marked in-flight as soon as signIn is called")

        await controller.submitCode("mycode#state", for: "demo")

        var collected: [String] = []
        for await line in stream { collected.append(line) }

        XCTAssertTrue(collected.contains { $0.contains("https://example.com/authorize") })
        XCTAssertTrue(collected.contains { $0.contains("got: mycode#state") })
        XCTAssertFalse(controller.isSigningIn("demo"), "must be cleared once the flow finishes")
    }

    @MainActor
    func testCancelSignInTerminatesAnInFlightFlowWithoutACode() async throws {
        let binary = try fakeAuthBinary()
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        let stream = await controller.signIn(provider: "demo")
        XCTAssertTrue(controller.isSigningIn("demo"))

        let drain = Task {
            for await _ in stream {}
        }
        await controller.cancelSignIn(for: "demo")
        _ = await drain.value

        XCTAssertFalse(controller.isSigningIn("demo"))
    }

    @MainActor
    func testSubmitCodeIsANoOpWhenNoFlowIsRunningForThatProvider() async {
        let binary = NexusBinary(url: URL(fileURLWithPath: "/bin/echo"))
        let controller = AuthController(client: NexusClient(binary: binary), binary: binary)

        // Must not crash/hang — there is nothing listening for this provider.
        await controller.submitCode("abc#123", for: "never-started")
        XCTAssertFalse(controller.isSigningIn("never-started"))
    }
}
