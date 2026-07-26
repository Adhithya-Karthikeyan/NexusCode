#!/usr/bin/env bash
# Build NexusCode.app from the SPM executable.
#
# SwiftUI needs a real bundle for the things that make it feel like a Mac app —
# a menu bar, a Dock icon, window restoration. SPM emits a bare executable, so
# this wraps it in the minimal bundle layout around it. Deliberately a script
# rather than an Xcode project: it runs headlessly in CI and stays verifiable
# from the terminal, which is the same reason NexusKit is testable without a UI.
set -euo pipefail

CONFIG="${1:-debug}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> building ($CONFIG)"
swift build -c "$CONFIG" --product NexusApp

BIN="$(swift build -c "$CONFIG" --product NexusApp --show-bin-path)/NexusApp"
[ -x "$BIN" ] || { echo "executable not found at $BIN" >&2; exit 1; }

APP="$ROOT/.build/NexusCode.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/NexusCode"

# Copy the SPM resource bundles (test fixtures excluded) so anything the app
# loads at runtime resolves the same way it does under `swift test`.
for bundle in "$(dirname "$BIN")"/*.bundle; do
  [ -e "$bundle" ] || continue
  case "$(basename "$bundle")" in
    *Tests*) continue ;;
  esac
  cp -R "$bundle" "$APP/Contents/Resources/"
done

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>NexusCode</string>
    <key>CFBundleDisplayName</key><string>NexusCode</string>
    <key>CFBundleIdentifier</key><string>dev.nexuscode.mac</string>
    <key>CFBundleExecutable</key><string>NexusCode</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <!-- A regular app: real Dock icon, real menu bar, real window management. -->
    <key>LSUIElement</key><false/>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticTermination</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signature so Gatekeeper lets a locally built app launch.
codesign --force --sign - "$APP" >/dev/null 2>&1 || \
  echo "    (codesign unavailable — the app may need a right-click > Open)"

echo "==> built $APP"
echo "    open $APP"
