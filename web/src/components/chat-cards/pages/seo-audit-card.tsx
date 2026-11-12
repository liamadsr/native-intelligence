'use client'

/**
 * SEO's Site audit as a card: the real Site audit page, the workspace's
 * audits or one audit. Opening an audit, and Back, move the card (the
 * `seo_audit` place, a step the header's Back walks); the audit's Findings
 * and Pages are the card's tabs (PAGE_KINDS.seo_audit.tabs). It is not a
 * views-system list, so there is nothing of the person's to keep with the
 * card beyond where it is, and read_card points the agent at the audit tools.
 */
import * as React from 'react'
import { SiteAuditPage } from '@/app/account/(dashboard)/seo/site-audit-view'
import { pageTab } from '@/lib/chat-cards/pages'
import { usePagePlace, type PageCardProps } from './page-card'

export default function SeoAuditCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const audit = place.at?.type === 'seo_audit' ? place.at : null
  return (
    <div className="h-full min-h-0" data-seo-audit-card="">
      <SiteAuditPage
        auditId={audit?.id ?? null}
        auditLabel={audit?.label}
        tab={pageTab('seo_audit', place.tab)}
        onOpenAudit={(a) => place.go({ type: 'seo_audit', id: a.id, label: a.host })}
        onCloseAudit={() => place.go(null)}
        onTab={place.setTab}
        onCount={props.onCount}
      />
    </div>
  )
}
