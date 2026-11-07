import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const { name, email, message } = await request.json()

    // Here you would typically send the email using a service like SendGrid, Resend, etc.
    // For now, I'll provide a basic structure that you can extend with your preferred email service

    // Example with console log (replace with actual email sending logic)
    console.log('Contact form submission:', {
      to: 'liam@dial8.ai',
      from: email,
      subject: `Contact form submission from ${name}`,
      body: `
        Name: ${name}
        Email: ${email}
        Message: ${message}
      `
    })

    // TODO: Implement actual email sending logic here
    // Example services you could use:
    // - Resend (resend.com)
    // - SendGrid
    // - AWS SES
    // - Postmark

    // Track server-side event
    const posthog = getPostHogServerClient()
    posthog?.capture({
      distinctId: email,
      event: 'contact_form_submitted',
      properties: { ...serverDefaultProperties },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Contact form error:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}