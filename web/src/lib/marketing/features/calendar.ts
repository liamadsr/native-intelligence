import type { FeaturePage } from './types'

export const calendar: FeaturePage = {
  slug: 'calendar',
  name: 'Calendar',
  title: 'Every calendar in one place, every meeting linked to its notes.',
  lead: 'See Google and Outlook calendars side by side. Each meeting opens with its notes, its people and the calls before it, and the agent finds times that work.',
  worksWith: 'Works with Google Calendar and Outlook',
  metaTitle: 'Calendar: Google and Outlook in one place',
  metaDescription:
    'Google and Outlook calendars in one view, each meeting linked to its notes and people, with prep before a call and times found for the whole team.',
  intro: [
    'A calendar says when a meeting is, but not what it is about. The notes from the last call, the open tasks and the history with the people coming all live somewhere else.',
    'In Native Intelligence the calendar is part of the workspace. A meeting links to its recording and notes, the people on the invite link to their contact records, and the agent can read your schedule, change it and find a time.',
  ],
  sections: [
    {
      id: 'all-calendars',
      nav: 'All calendars',
      title: 'All your calendars in one view.',
      body: 'Connect as many Google Calendar and Outlook accounts as you use, and see them together by day, week or month. Show or hide a whole account or a single calendar, and create, change or delete events from the same place.',
      points: ['Attendees, location and call links on every event', 'Show or hide each calendar', 'Create an event yourself or by asking the agent'],
    },
    {
      id: 'linked-notes',
      nav: 'Linked notes',
      title: 'Each meeting opens with its notes.',
      body: 'A meeting you recorded links to its capture, so the notes and transcript are one click from the event. A repeating meeting shows the earlier calls in its series. Start recording from an upcoming event, or add a capture to one that already happened.',
    },
    {
      id: 'auto-record',
      nav: 'Auto-record',
      title: 'Recording starts when the meeting does.',
      body: 'With the Mac app, a calendar meeting with other people on it can start recording on its own when it begins. The capture is tied to the right event and its attendees, who are linked to your contacts.',
    },
    {
      id: 'prep',
      nav: 'Prep',
      title: 'Ready for every meeting before it starts.',
      body: 'Ask the agent to prepare you for a meeting and it gathers the earlier calls, open tasks, decisions and what is known about the people coming. You can also have a spoken prep read to you as you open the meeting.',
    },
    {
      id: 'find-time',
      nav: 'Find a time',
      title: 'Find a time that works for everyone.',
      body: 'Ask for a time with teammates and the agent checks each person’s working hours in their own time zone and when they are busy, without reading what their events are. It suggests a few times on different days, ready to send.',
      points: [
        'Set your working hours once',
        'Offer an outside person two or three times, held until they pick one',
        'Run a poll when several people need to agree',
      ],
    },
    {
      id: 'booking-links',
      nav: 'Booking links',
      title: 'Let people book time with you.',
      body: 'Make a booking link with the meeting length, buffers, notice and questions you want, and share it. Bookings land on your calendar, and one link can be hosted by several people on your team.',
    },
    {
      id: 'ask-the-agent',
      nav: 'Ask the agent',
      title: 'Change your schedule in a sentence.',
      body: 'Ask the agent what is on this week, to move a meeting, or to add one with the right people. It works on your connected calendars and reads every time in your own time zone.',
    },
  ],
  faq: [
    {
      q: 'Which calendars can I connect?',
      a: 'Google Calendar and Outlook. Connect as many accounts as you use and choose which calendars show.',
    },
    {
      q: 'Can teammates see what my meetings are about?',
      a: 'Not when the agent looks for a time. It uses only when each person is busy and their working hours, never what their events are.',
    },
    {
      q: 'Do I need the Mac app?',
      a: 'No. The calendar works in the browser. The Mac app adds recording that starts with a meeting, and your next meetings in the menu bar.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['booking-links', 'meetings', 'mail'],
}
