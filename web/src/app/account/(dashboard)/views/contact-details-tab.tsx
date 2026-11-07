'use client'

import { useMemo } from 'react'
import { buildContactDetails, type ContactDetailsInput } from '@/lib/crm/contact-details'
import {
  DetailSectionView,
  DetailsEmptyState,
  DetailsStatusLine,
  SourcesList,
  UnverifiedGroup,
} from './details-tab-parts'

/**
 * The contact panel's Details tab: what a person does, how to reach them,
 * what they know, where they've been (a timeline), where they studied (a
 * timeline), anything notable — each field with a hover copy button and,
 * for web-sourced values, a dot that opens the page it came from.
 *
 * The enricher's bio paragraph is deliberately absent: it lives in
 * `contact.notes` and is shown on Overview, so this tab is the structured
 * complement, not a second copy.
 *
 * No enrich control of its own — the toolbar's sparkle button is the one
 * way to run it; the empty state points at it.
 */
export function ContactDetailsTab({
  contact,
  enriching,
}: {
  contact: ContactDetailsInput & { full_name: string }
  enriching: boolean
}) {
  const model = useMemo(() => buildContactDetails(contact), [contact])
  const scope = contact.full_name || 'this person'
  const hasAnything = model.fieldCount > 0 || model.unverified.length > 0

  return (
    <div className="px-8 pb-28 pt-6 space-y-7">
      <DetailsStatusLine model={model} enriching={enriching} subject={scope} />

      {!hasAnything ? (
        <DetailsEmptyState
          foundNothing={model.status === 'enriched'}
          sources={model.sources}
          fills="title, seniority, location, expertise, previous roles and education"
          scope={scope}
        />
      ) : (
        <>
          {model.sections.map((section) => (
            <DetailSectionView key={section.key} section={section} />
          ))}

          <UnverifiedGroup fields={model.unverified} scope={scope} />

          <SourcesList sources={model.sources} />
        </>
      )}
    </div>
  )
}
