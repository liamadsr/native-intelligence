import { z } from 'zod'

export const nativeSnapshotTimingsSchema = z.object(Object.fromEntries(
  ['controlScan', 'targetBuild', 'viewportText', 'completionEvidence', 'documentLinks', 'total'].map(key => [key, z.number().int().min(0).max(60000)]),
)).strict()

/** Only bounded categories and counters leave the device. Never retain native
 * exception messages or the rejected snapshot: either may contain page data. */
export const browserTaskDiagnosticsSchema = z.object({
  snapshotAttempts: z.number().int().min(0).max(10000),
  startupRetries: z.number().int().min(0).max(10000),
  snapshotReads: z.array(z.object({
    phase: z.enum(['startup', 'step', 'settle', 'completion']),
    elapsedMs: z.number().int().min(0).max(60000), budgetMs: z.number().int().min(0).max(60000),
    outcome: z.enum(['read', 'runtime_starting', 'invalid_snapshot', 'native_read_failed', 'read_timeout', 'cancelled']),
    native: nativeSnapshotTimingsSchema.optional(),
  }).strict()).max(96).optional(),
  lastSnapshotFailure: z.object({
    phase: z.enum(['startup', 'step', 'settle', 'completion']),
    code: z.enum(['runtime_starting', 'invalid_snapshot', 'native_read_failed', 'read_timeout']),
  }).optional(),
  lastEvidenceFailure: z.object({
    issueCode: z.enum(['invalid_type', 'invalid_value', 'invalid_format', 'too_small', 'too_big', 'unrecognized_keys', 'custom', 'other']),
    section: z.enum(['ledger', 'page', 'snippet', 'link']),
  }).optional(),
})
export type BrowserTaskDiagnostics = z.infer<typeof browserTaskDiagnosticsSchema>
export type SnapshotPhase = NonNullable<BrowserTaskDiagnostics['lastSnapshotFailure']>['phase']
