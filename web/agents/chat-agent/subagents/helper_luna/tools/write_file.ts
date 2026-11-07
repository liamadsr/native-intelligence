// Lockdown, mirroring the plain helper's tools/write_file.ts: no sandbox, coding or
// framework-skill surface, so eve's default `write_file` is removed structurally.
// lib/__tests__/helper-subagent.test.ts keeps this set equal to the root's
// (minus `agent`, which eve gives the root alone).
import { disableTool } from 'eve/tools'

export default disableTool()
