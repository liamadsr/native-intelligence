/**
 * A re-ingest never rewrites a canon document (canon D2): the update of a page
 * generated from an attachment is fenced on `canon_key is null`, so a page
 * someone has since made canon changes only through propose_section_edit.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(process.cwd(), 'src/lib/inngest/reference-ingest.ts'), 'utf8').replace(/\s+/g, ' ')

describe('reference ingest and canon documents', () => {
  it('the re-ingest update of an existing generated page skips a canon document', () => {
    expect(SRC).toContain(".from('document') .update(fields) .eq('id', existingId) .eq('workspace_id', data.workspaceId) .is('canon_key', null)")
  })
})
