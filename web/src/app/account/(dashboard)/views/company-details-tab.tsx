'use client'

import { useMemo } from 'react'
import { CopyValueButton } from '@/components/views/copy-value-button'
import { buildCompanyDetails, type CompanyDetailsInput } from '@/lib/crm/company-details'
import {
  DetailSectionView,
  DetailsEmptyState,
  DetailsStatusLine,
  SourcesList,
  UnverifiedGroup,
} from './details-tab-parts'
import { Linkify } from '@/components/ui/linkify'

/**
 * The company panel's Details tab: everything known about the company as
 * first-class, sectioned fields — industry and stage, size, funding, who runs
 * it, what it sells, what's new — each with a hover copy button and, for
 * web-sourced values, a dot that opens the page it came from.
 *
 * Pure presentation over `buildCompanyDetails`; the model decides what goes
 * where and what is trustworthy enough to show as the record. Companies have
 * no notes column, so the enricher's summary paragraph leads the tab.
 *
 * No enrich control of its own: the panel toolbar's sparkle button is THE way
 * to run (or re-run) enrichment, and the empty state points at it rather
 * than duplicating it.
 */
export function CompanyDetailsTab({
  company,
  enriching,
}: {
  company: CompanyDetailsInput & { name: string }
  enriching: boolean
}) {
  const model = useMemo(() => buildCompanyDetails(company), [company])
  const scope = company.domain || company.name
  const hasAnything =
    model.fieldCount > 0 || model.unverified.length > 0 || model.summary !== null

  return (
    <div className="px-8 pb-28 pt-6 space-y-7">
      <DetailsStatusLine model={model} enriching={enriching} subject={scope} />

      {!hasAnything ? (
        <DetailsEmptyState
          foundNothing={model.status === 'enriched'}
          sources={model.sources}
          fills="industry, size, funding, leadership, products and recent news"
          scope={scope}
        />
      ) : (
        <>
          {model.summary && (
            <div className="group/row flex items-start gap-2">
              <p className="min-w-0 flex-1 text-sm leading-relaxed"><Linkify text={model.summary} /></p>
              <CopyValueButton value={model.summary} label="summary" />
            </div>
          )}

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
