/**
 * The Tauri API, loaded once and shared by the HUD's pieces — lazily, so the
 * server render never touches it. One promise per module: two pieces importing
 * the same module at once is how a test's mock of it can be missed.
 */
let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
let coreApi: Promise<typeof import('@tauri-apps/api/core')> | null = null
let windowApi: Promise<typeof import('@tauri-apps/api/webviewWindow')> | null = null

export const tauriEvent = () => (eventApi ??= import('@tauri-apps/api/event'))
export const tauriCore = () => (coreApi ??= import('@tauri-apps/api/core'))
export const tauriWindow = () => (windowApi ??= import('@tauri-apps/api/webviewWindow'))
