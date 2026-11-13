/**
 * The version of what draws an export, compared between the Studio on the server and the engine the desktop app
 * bundles (an export run on the person's own computer, job-contract.ts `local-export`): the server refuses a local
 * export whose version is not its own, and that video is exported on the server instead.
 *
 * What it covers: every file the render's entry point (remotion.tsx) imports, and the worker's composition without the
 * browser (studio-worker/src/fast-export.ts, fast-export-run.ts, fast-sound.ts) with what they import, followed through
 * relative and `@/` imports. Their contents, line ends made LF, hash to RENDER_SOURCES_SHA256; a test
 * (__tests__/render-version.test.ts) fails when they change and this file does not: change the version and the hash
 * together. Constants only: the desktop app's bundle reads this file as it is.
 */
export const STUDIO_RENDER_VERSION = '2026-11-13.3'

/** The hash of the files above when STUDIO_RENDER_VERSION was last changed. */
export const RENDER_SOURCES_SHA256 = 'c7718ec862ffdbda7f0357890ab975d112fe4c2a0c81085e373bed6e3db8ddad'
