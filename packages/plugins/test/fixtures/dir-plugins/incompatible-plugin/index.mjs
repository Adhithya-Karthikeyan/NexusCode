/**
 * This module must NEVER be imported: the host rejects the plugin on the
 * `engines.nexuscode` version gate before loading its code. The throw proves it.
 */
throw new Error("incompatible-plugin code was imported despite the version gate");
