import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = {
  title: 'Payment received',
  robots: { index: false, follow: false },
}

/** Where a customer lands after paying a payment link (roadmap C2). The business is told by text. */
export default function PaymentPaidPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-foreground lg:p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Thank you, your payment went through</CardTitle>
          <CardDescription>The business has been told. You can close this page.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
