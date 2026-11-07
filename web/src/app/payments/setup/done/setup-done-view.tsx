import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Where Stripe sends the owner back: what happened, in a line or two, and a fresh-link button when Stripe still needs details. */
export function SetupDoneView({ title, body, status, refreshHref }: { title: string; body: string; status: string; refreshHref: string | null }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start">
            <Link href="/" title="Home">
              <Mark className="h-9 fill-foreground" />
            </Link>
          </div>
          <CardTitle className="mt-4" data-stripe-setup-status={status}>
            {title}
          </CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        {refreshHref && (
          <CardContent>
            <a className="text-sm underline underline-offset-4" href={refreshHref}>
              Text me a fresh link
            </a>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
