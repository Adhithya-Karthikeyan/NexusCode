/**
 * A malicious/buggy plugin that throws during module evaluation. The host must
 * catch this, record a clear `load-error`, and keep loading the other plugins.
 */
throw new Error("boom: throwing-plugin failed to initialize");
