import { Mark } from '@/components/logo'
import { Link } from '@/components/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PAYMENTS_PATHS } from '@/lib/payments/config'

export type SetupLinkState =
  | { kind: 'invalid' | 'expired' | 'used' }
  | { kind: 'connected'; business: string }
  | { kind: 'ready'; business: string; canLinkExisting: boolean; resuming: boolean }

const DEAD: Record<'invalid' | 'expired' | 'used', { title: string; body: string }> = {
  invalid: { title: 'This link no longer works', body: 'Text your Native Intelligence agent “connect Stripe” and it will send you a fresh link.' },
  expired: { title: 'This link has expired', body: 'Setup links work for 15 minutes. Text your Native Intelligence agent “connect Stripe” for a fresh one.' },
  used: { title: 'This link was already used', body: 'Each setup link works once. Text your Native Intelligence agent “connect Stripe” if you need a fresh one.' },
}

/**
 * The setup page's card. Plain forms (no script): each button POSTs once and
 * the response sends the browser on to Stripe.
 */
export function SetupLinkView({ token, state }: { token: string; state: SetupLinkState }) {
  const dead = state.kind === 'invalid' || state.kind === 'expired' || state.kind === 'used' ? DEAD[state.kind] : null
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-start">
            <Link href="/" title="Home">
              <Mark className="h-9 fill-foreground" />
            </Link>
          </div>
          <CardTitle className="mt-4">
            {dead ? dead.title : state.kind === 'connected' ? 'Stripe is connected' : state.kind === 'ready' ? `Take card payments for ${state.business}` : null}
          </CardTitle>
          <CardDescription>
            {dead
              ? dead.body
              : state.kind === 'connected'
                ? `Customers can already pay ${state.business} by card. There is nothing more to do here.`
                : 'Customers pay on Stripe’s page and the money goes straight into your own Stripe account. You keep full access to it in your Stripe Dashboard.'}
          </CardDescription>
        </CardHeader>
        {state.kind === 'ready' && (
          <CardContent className="space-y-4">
            <form method="post" action={PAYMENTS_PATHS.setupAction(token)}>
              <input type="hidden" name="mode" value="new" />
              <Button type="submit" className="w-full" data-stripe-setup-new>
                {state.resuming ? 'Continue Stripe setup' : 'Set up Stripe'}
              </Button>
            </form>
            {state.canLinkExisting && (
              <form method="post" action={PAYMENTS_PATHS.setupAction(token)}>
                <input type="hidden" name="mode" value="existing" />
                <Button type="submit" variant="outline" className="w-full" data-stripe-setup-existing>
                  I already have a Stripe account
                </Button>
              </form>
            )}
            <p className="text-sm text-muted-foreground">
              Stripe asks for your business details and where to send your money. Stripe takes its usual card fee from each payment; Native Intelligence never sees your card or bank details. This link works once.
            </p>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
