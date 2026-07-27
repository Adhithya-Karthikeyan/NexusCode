import Foundation

/// Decides which directory a window should open on.
///
/// Pure and separate from the SwiftUI layer so it can be tested: the rule has
/// several edge cases (Finder launches with a useless working directory, a
/// remembered path whose folder has since been deleted) and getting them wrong
/// means the app silently opens on the wrong project — or on `/`, where it finds
/// no `nexus` and no `.omc` and looks broken.
public enum ProjectLocation {
    /// Resolve the directory to open.
    ///
    /// Order: the directory the user last chose (if it still exists), then the
    /// process working directory when it looks like a real project, then a
    /// dedicated, empty workspace folder — NEVER the home directory itself.
    ///
    /// A launch from Finder reports `/` as the working directory, which is never
    /// a project, so it is explicitly rejected rather than accepted as a default.
    /// A launch from a Terminal sitting at `~` (`cd ~ && open NexusCode.app`, or
    /// `swift run` invoked from a login shell) reports the home directory
    /// itself — non-empty and not `/`, so it used to pass as "plausible" and
    /// become the project root. That is the one directory a file indexer must
    /// never be pointed at by default: on a real machine it's tens of thousands
    /// of files, which is slow, trips a macOS "access your Documents folder"
    /// permission prompt on first launch, and turns a should-be-instant window
    /// open into a multi-second index of someone's entire life. So it is
    /// rejected here the same way `/` is.
    public static func resolve(
        remembered: String?,
        workingDirectory: String,
        home: String,
        directoryExists: (String) -> Bool
    ) -> URL {
        if let remembered, !remembered.isEmpty, directoryExists(remembered) {
            return URL(fileURLWithPath: remembered)
        }
        if isPlausibleProject(workingDirectory), workingDirectory != home, directoryExists(workingDirectory) {
            return URL(fileURLWithPath: workingDirectory)
        }
        return URL(fileURLWithPath: fallbackWorkspacePath(home: home))
    }

    /// Whether a path could sensibly be a project root.
    ///
    /// `/` and an empty path are the two values a GUI launch actually produces,
    /// and neither can contain a checkout. The home directory is rejected
    /// separately, in `resolve` — it needs `home` to compare against, which this
    /// single-argument helper doesn't have — so it stays `true` here.
    public static func isPlausibleProject(_ path: String) -> Bool {
        !path.isEmpty && path != "/"
    }

    /// The last-resort default when nothing usable was remembered or inherited:
    /// a small, dedicated folder under Application Support rather than the home
    /// directory. It starts empty, so a fresh launch has nothing to index and
    /// nothing to prompt Full Disk / Documents access for — the opposite of
    /// silently treating "no project chosen yet" as "index everything."
    static func fallbackWorkspacePath(home: String) -> String {
        home + "/Library/Application Support/NexusCode/Workspace"
    }

    /// Convenience over the real file system.
    public static func resolve(
        remembered: String?,
        fileManager: FileManager = .default
    ) -> URL {
        let resolved = resolve(
            remembered: remembered,
            workingDirectory: fileManager.currentDirectoryPath,
            home: NSHomeDirectory(),
            directoryExists: { path in
                var isDirectory: ObjCBool = false
                let exists = fileManager.fileExists(atPath: path, isDirectory: &isDirectory)
                return exists && isDirectory.boolValue
            }
        )
        // The fallback workspace isn't shipped with the app — a fresh install
        // has nothing under Application Support yet. Create it on demand so
        // the window never opens on a path that doesn't exist: CLI discovery
        // and the OMC watcher both assume `projectDirectory` is real.
        // Idempotent — does nothing when `resolved` already exists, which is
        // every launch that resolved to a remembered or inherited directory.
        try? fileManager.createDirectory(at: resolved, withIntermediateDirectories: true)
        return resolved
    }
}
