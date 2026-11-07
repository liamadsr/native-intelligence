import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { verifyUnsubscribeToken } from '@/lib/email'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const email = searchParams.get('email')
  const token = searchParams.get('token')

  if (!email || !token) {
    return new NextResponse(unsubscribePage('Invalid unsubscribe link.', false), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    })
  }

  if (!verifyUnsubscribeToken(email, token)) {
    return new NextResponse(unsubscribePage('Invalid unsubscribe link.', false), {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    })
  }

  const supabase = getServiceClient()

  const { error } = await supabase
    .from('early_access')
    .update({ unsubscribed: true })
    .eq('email', email)

  if (error) {
    console.error('Unsubscribe error:', error.message)
    return new NextResponse(unsubscribePage('Something went wrong. Please try again.', false), {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    })
  }

  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: email,
    event: 'email_unsubscribed',
    properties: serverDefaultProperties,
  })

  return new NextResponse(unsubscribePage("You've been unsubscribed.", true), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  })
}

function unsubscribePage(message: string, success: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe - Dial8</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f6f9fc;
      color: #4a4a4a;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 40px;
      max-width: 400px;
      text-align: center;
    }
    h1 { color: #1a1a1a; font-size: 20px; margin: 0 0 12px; }
    p { font-size: 16px; line-height: 24px; margin: 0; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="${success ? 'success' : 'error'}">${message}</h1>
    ${success ? '<p>You won\'t receive any more emails from Dial8.</p>' : ''}
  </div>
</body>
</html>`
}
