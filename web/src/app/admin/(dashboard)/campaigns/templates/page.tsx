import { AdminPageHeader } from '@/components/admin/shared'
import { EmailTemplateList } from '../email-preview'

export const dynamic = 'force-dynamic'

export default function TemplatesPage() {
  return (
    <div>
      <AdminPageHeader
        title="Email Templates"
        description="Create, preview, and edit reusable email templates for your campaigns"
      />
      <div className="mt-6">
        <EmailTemplateList />
      </div>
    </div>
  )
}
