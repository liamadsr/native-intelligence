// Must load before anything decodes video. @remotion/media keeps decoded preview frames in a cache whose default
// budget is 1 GB; in Safari's WebKit (the desktop app) those frames live in ordinary memory, so with 4K screen
// recordings the editor's web process grew past 2 GB, pushed macOS into critical memory pressure and crashed during
// playback. 256 MB (the library's floor is 240 MB) keeps a few seconds of preview frames. Exports are unaffected:
// they render in their own headless browser.
(window as unknown as { remotion_mediaCacheSizeInBytes?: number }).remotion_mediaCacheSizeInBytes = 256 * 1024 * 1024;
export {};
