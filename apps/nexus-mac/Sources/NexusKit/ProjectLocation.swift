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
    /// process working directory when it looks like a real project, then home.
    /// A launch from Finder reports `/` as the working directory, which is never
    /// a project, so it is explicitly rejected rather than accepted as a default.
    public static func resolve(
        remembered: String?,
        workingDirectory: String,
        home: String,
        directoryExists: (String) -> Bool
    ) -> URL {
        if let remembered, !remembered.isEmpty, directoryExists(remembered) {
            return URL(fileURLWithPath: remembered)
        }
        if isPlausibleProject(workingDirectory), directoryExists(workingDirectory) {
            return URL(fileURLWithPath: workingDirectory)
        }
        return URL(fileURLWithPath: home)
    }

    /// Whether a path could sensibly be a project root.
    ///
    /// `/` and an empty path are the two values a GUI launch actually produces,
    /// and neither can contain a checkout.
    public static func isPlausibleProject(_ path: String) -> Bool {
        !path.isEmpty && path != "/"
    }

    /// Convenience over the real file system.
    public static func resolve(
        remembered: String?,
        fileManager: FileManager = .default
    ) -> URL {
        resolve(
            remembered: remembered,
            workingDirectory: fileManager.currentDirectoryPath,
            home: NSHomeDirectory(),
            directoryExists: { path in
                var isDirectory: ObjCBool = false
                let exists = fileManager.fileExists(atPath: path, isDirectory: &isDirectory)
                return exists && isDirectory.boolValue
            }
        )
    }
}
