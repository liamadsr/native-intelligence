import type { FeaturePage } from './types'

export const bookingLinks: FeaturePage = {
  slug: 'booking-links',
  name: 'Booking links',
  title: 'Let people pick a time that works.',
  lead: 'Share a link and people book from your real availability. Or offer someone two or three times, held on your calendar until they pick one.',
  worksWith: 'Works with Google Calendar and Outlook calendar',
  metaTitle: 'Booking links and time offers',
  metaDescription:
    'Booking links that read every calendar you connect, team links that share the load, and time offers held on your calendar until the guest picks one.',
  intro: [
    'Finding a time by email takes four messages and a day. Most of it is copying slots out of a calendar that already knows when you are free.',
    'Booking links read your working hours and every calendar you have connected, so the times on offer are real. And because they live in the same workspace as your mail and your contacts, the assistant can hand out the right link, or offer someone a few times, when an email asks to meet.',
  ],
  sections: [
    {
      id: 'links',
      nav: 'Links',
      title: 'A link people book from.',
      body: 'A booking link is a page where anyone can pick a time with you. It offers your working hours, minus everything busy on all your calendars, and books the meeting on your calendar with a video link.',
      points: [
        'Set the length, buffers before and after, and notice needed',
        'Choose how many days ahead it opens, and a daily limit',
        'Ask guests a few questions when they book',
        'Meet on video, at a place, or on a team call where calls are set up',
      ],
    },
    {
      id: 'ask-first',
      nav: 'Ask first',
      title: 'Approve each booking, if you want.',
      body: 'Turn on ask first, and each request waits for your yes before it is booked. Leave it off, and a booking goes straight onto your calendar.',
    },
    {
      id: 'team',
      nav: 'Team links',
      title: 'Links for the whole team.',
      body: 'Add teammates as hosts. Book a time when everyone is free and everyone attends, or when any one of them is free, going to whoever has the fewest bookings. Owners and admins can make links under the workspace’s own name.',
    },
    {
      id: 'offer-times',
      nav: 'Offer times',
      title: 'Offer two or three times instead.',
      body: 'For one person, offer a few specific times. Each is checked free and held on your calendar until they pick one or the offer expires. They pick on a private link or by replying, and the meeting is booked with an invitation from your calendar.',
      points: [
        'Paste the link and text into any message yourself',
        'Or have it sent by email, after you approve exactly what goes out',
        'Take an offer back, and its held times are freed',
      ],
    },
    {
      id: 'polls',
      nav: 'Polls',
      title: 'Find a time for a group.',
      body: 'Offer times to several people at once. Each marks every time that works, and when the last one answers, the earliest time that suits everyone is booked. Remind the ones who have not answered.',
    },
    {
      id: 'in-chat',
      nav: 'In chat',
      title: 'Ask the assistant to find a time.',
      body: 'Say “send Lena a few times next week” or “make me a 30-minute link” in chat. The assistant reads your calendars, makes the link or the offer, and shows it to you before anything is sent.',
    },
  ],
  faq: [
    {
      q: 'Which calendars does it check?',
      a: 'Every calendar you have connected, Google Calendar and Outlook calendar alike, against the working hours you set.',
    },
    {
      q: 'Where do I set up my links?',
      a: 'Under Availability, in the calendar, next to your working hours. Each link has its own address to share, or ask the assistant to make one in chat.',
    },
    {
      q: 'Does the assistant send offers on its own?',
      a: 'No. By default it gives you a link and text to paste. Sending by email waits for your approval of exactly who gets what.',
    },
    {
      q: 'Can I turn a link off?',
      a: 'Yes. A link that is off stops taking bookings, and the meetings it already booked stay on your calendar.',
    },
  ],
  related: ['calendar', 'mail', 'crm'],
}
