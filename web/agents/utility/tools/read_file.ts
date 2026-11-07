// Harness lockdown: the utility agent runs one-shot generations with NO tools.
// eve provisions a sandbox by default and makes its shell/filesystem tools live
// unless each is disabled, so every sandbox-backed default is removed here
// structurally (never left to prose). The sandbox itself can still be
// provisioned: any file part in a task message makes eve open the agent's
// sandbox and stage the bytes there (reference_ingest_* sends the PDF that
// way — see src/lib/inngest/reference-ingest.ts). With every tool off, nothing
// in a session can run a command in it or read from it.
import { disableTool } from 'eve/tools'

export default disableTool()
