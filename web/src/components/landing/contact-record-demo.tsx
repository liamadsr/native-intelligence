'use client'

/**
 * The CRM on the landing page: the app's own contact record
 * (app/account/(dashboard)/views/contact-detail-panel.tsx), not a drawing of
 * it, opened on a made-up customer (lib/demo/snapshots/contact.ts). When the
 * panel changes in the app, this changes with it.
 */
import { useMemo } from 'react'
import { ContactDetailPanel } from '@/app/account/(dashboard)/views/contact-detail-panel'
import { DemoWorkspace } from '@/components/demo/demo-workspace'
import { contactSnapshot, DEMO_CONTACT_ID } from '@/lib/demo/snapshots/contact'
import { DemoSky } from './demo-card'

const noop = () => {}

export function ContactRecordDemo() {
  const snapshot = useMemo(() => contactSnapshot(), [])
  return (
    <DemoSky>
      <DemoWorkspace snapshot={snapshot} className="h-[560px] w-full text-left">
        <ContactDetailPanel contactId={DEMO_CONTACT_ID} onClose={noop} />
      </DemoWorkspace>
    </DemoSky>
  )
}
