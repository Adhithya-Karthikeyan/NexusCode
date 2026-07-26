// swift-tools-version: 6.0
import PackageDescription

// NexusCode for macOS.
//
// The app is a RENDERER and a CONTROLLER over the `nexus` CLI — never a second
// implementation of it. Every action the UI offers is a `nexus` command, and
// everything the UI shows is decoded from that command's `-o ndjson` event
// stream. That split is what keeps the terminal authoritative: a feature cannot
// exist in the app without existing in the CLI first.
//
// `NexusKit` holds everything that is pure logic (event decoding, the view-state
// fold, the process bridge, themes) so it is testable headlessly with
// `swift test` — no window, no UI, no simulator. `NexusApp` is the SwiftUI shell
// on top and contains no business logic of its own.
let package = Package(
    name: "NexusMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "NexusKit", targets: ["NexusKit"]),
        .executable(name: "NexusApp", targets: ["NexusApp"]),
    ],
    targets: [
        .target(name: "NexusKit"),
        .executableTarget(name: "NexusApp", dependencies: ["NexusKit"]),
        .testTarget(
            name: "NexusKitTests",
            dependencies: ["NexusKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
