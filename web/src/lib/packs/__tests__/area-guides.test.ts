/**
 * Area guides (src/lib/packs/area-guides.ts): how each area's tools work,
 * moved out of the main chat's always-on prompt into the area's pack.
 *
 * Pinned:
 *   1. every guide is an area's, the bullets alone (the renderer heads it);
 *   2. a pack carries its guide after its playbook, an area with only a guide
 *      still loads, and a bare buildChatPacks call (no guides) is as before;
 *   3. the chat spec's packs carry the guides (rebuildChatPacks);
 *   4. what moved is still said, in its area's pack.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { AREA_GUIDES, areaGuide } from '../area-guides'
import { buildChatPacks, rebuildChatPacks } from '../chat-packs'
import { isAreaKey, PACKS } from '../registry'

const all = () => true
const guide = (area: keyof typeof AREA_GUIDES) => AREA_GUIDES[area] ?? ''

describe('area guides', () => {
  it('every guide is an area’s, as bullets with no heading of its own', () => {
    for (const [area, text] of Object.entries(AREA_GUIDES)) {
      expect(isAreaKey(area), area).toBe(true)
      expect(text!.startsWith('- '), area).toBe(true)
      expect(text, area).not.toMatch(/^#/m)
    }
    expect(areaGuide('evals')).toBe('')
  })

  it('a pack carries its guide after its playbook; a guide alone is enough to load; no guides is as before', () => {
    const skills = [{ name: 'mail-playbook', description: 'Mail', markdown: 'MAIL PLAYBOOK', area: 'mail', isSystem: true }]
    const withGuides = buildChatPacks({ skills, enabled: all, guides: AREA_GUIDES })
    const mail = withGuides.find((p) => p.area === 'mail')!
    expect(mail.markdown.indexOf('MAIL PLAYBOOK')).toBeGreaterThan(-1)
    expect(mail.markdown.indexOf(`## How ${PACKS.mail.name} works\n${guide('mail')}`)).toBeGreaterThan(mail.markdown.indexOf('MAIL PLAYBOOK'))
    // Knowledge has no playbook here, only its guide, and still loads.
    expect(withGuides.find((p) => p.area === 'knowledge')?.markdown).toContain(guide('knowledge'))
    // No guides passed: only the playbook's area has a pack, as before.
    expect(buildChatPacks({ skills, enabled: all }).map((p) => p.area)).toEqual(['mail'])
  })

  it('the chat spec’s packs carry the guides', async () => {
    const supabase = makeFakeSupabase({ project: true }) as unknown as SupabaseClient
    const packs = await rebuildChatPacks(supabase, { workspaceId: 'ws-1', userId: 'u-1' }, [], {})
    expect(packs.find((p) => p.area === 'actions')?.markdown).toContain(guide('actions'))
    expect(packs.find((p) => p.area === 'documents')?.markdown).toContain(guide('documents'))
  })

  it('what moved out of the base prompt is said in its area’s pack', () => {
    expect(guide('actions')).toContain('`reorder_actions`')
    expect(guide('actions')).toContain('one `create_actions_batch` call, never `create_action` many times in parallel')
    expect(guide('actions')).toContain('`confirmation: "suggested"` with `source_type: "chat_suggestion"`')
    expect(guide('actions')).not.toContain('`status: "suggested"`')
    const flows = guide('flows')
    expect(flows).toContain('Build it yourself: trigger `capture_processed`, one `run_skill` step on a lens skill.')
    expect(flows).toContain('`recipe_options`')
    expect(flows).toContain('`call_tool`')
    expect(guide('knowledge')).toContain('goes to `ingest_reference` instead, never `ingest_source`')
    expect(guide('actions')).toContain('never promise')
    expect(guide('projects')).toContain('one active per team at a time')
    expect(guide('captures')).toContain('several `find` searches from different angles')
    expect(guide('captures')).toContain('`get_capture_extractions`')
    expect(guide('captures')).toContain('`confirm_all_decisions`')
    expect(guide('captures')).toContain('draft the follow-up (`draft_followup_email`, never sent)')
    expect(guide('calendar')).toContain('`sync_calendar`')
    expect(guide('calendar')).toContain('`get_meeting_prep`')
    expect(guide('mail')).toContain('`create_email_draft` with `thread_id` and `in_reply_to`')
    expect(guide('mail')).toContain('Drafts are never sent')
    expect(guide('mail')).toContain('`[NEEDS INPUT')
    expect(guide('mail')).toContain('`update_email_thread`')
    expect(guide('mail')).toContain('The morning tidy')
    expect(guide('documents')).toContain('Canon documents are never archived or deleted.')
    expect(guide('documents')).toContain('`restore_document_revision`')
    expect(guide('knowledge')).toContain('`get_context_bundle(entity_type, entity_id)`')
    expect(guide('knowledge')).toContain('A package exports as markdown + JSONL with provenance')
    expect(guide('knowledge')).not.toContain('/api/')
    expect(guide('crm')).toContain('`get_company_overview`')
    expect(guide('browser')).toContain('`sourceReferences.citations`')
    expect(guide('content')).toContain('Never say a post was posted, scheduled or sent.')
  })
})
