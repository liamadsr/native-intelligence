/**
 * A test_flow DRY run's writes (F1 review). A dry run's skill steps run in
 * report mode, whose ceiling still holds REPORT_MODE_WRITE_ALLOWLIST
 * (create_document, add_comment, suggest_changes): on a real sample entity
 * (ENG-42) a test could comment on it or stage suggestions other people see.
 * So a run token minted for a dry run carries `dryRun` (skill-run-token.ts),
 * and the skill-run tool route answers every call that is not a read with
 * this echo instead of running it: what it would have written, nothing written.
 *
 * Pure: the registry's classification only.
 */
import { getToolSideEffect } from '@/lib/ai/tool-registry'

/** True when a dry run must not execute this tool (anything but a read; search_tools is a read). */
export function dryRunStubs(toolName: string): boolean {
  if (toolName === 'search_tools') return false
  return getToolSideEffect(toolName) !== 'read'
}

/** The output a dry run's write gets instead of running: the input it would have written, echoed back. */
export function dryRunWriteEcho(toolName: string, input: unknown): Record<string, unknown> {
  return {
    success: true,
    dry_run: true,
    written: false,
    message: `Test run: ${toolName} did not run and nothing was written. This is what it would have written; carry on as if it had, and say so in your result.`,
    would_have_written: input ?? {},
  }
}
