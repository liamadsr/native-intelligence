import type { ReactNode } from 'react'
import { Mark } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { LinkPurposeView } from '@/lib/links/purposes'

/** What /l/done says for each way a link's flow ends (the agent says the rest by text). */
export const LINK_DONE_COPY: Record<string, { title: string; description: string }> = {
  connected: { title: "You're connected", description: "You can close this page. I've texted you what's next." },
  partial: { title: 'Partly connected', description: "Part of it connected. I've texted you what happened." },
  failed: { title: "That didn't connect", description: 'Nothing was connected. Text Dial8 for a new link and try again.' },
  invalid: { title: 'This link no longer works', description: 'It was already used or it expired. Text Dial8 for a new one.' },
}

/** The card a single-use link's pages share (src/app/l/[token], src/app/l/done). */
export function LinkCard({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start">
            <Mark className="h-9 fill-foreground" />
          </div>
          <CardTitle className="mt-4">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children && <CardContent className="space-y-4">{children}</CardContent>}
      </Card>
    </div>
  )
}

/**
 * An unused link's page: what it does, the (masked) number it was sent to,
 * and the button, a plain form POST to /api/links/<token> (no script needed).
 */
export function LinkConfirm({ view, maskedPhone, action }: { view: LinkPurposeView; maskedPhone: string; action: string }) {
  return (
    <LinkCard title={view.title} description={view.body}>
      <p className="text-sm text-muted-foreground" data-link-phone>
        For the Dial8 account texting <strong className="whitespace-nowrap text-foreground">{maskedPhone}</strong>. Only continue if Dial8 sent this link to your phone.
      </p>
      <form method="post" action={action}>
        <Button type="submit" className="w-full" data-link-continue>
          {view.button}
        </Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">This link works once, and only for a few minutes.</p>
    </LinkCard>
  )
}
