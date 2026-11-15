import type { FeaturePage } from './types'

export const mail: FeaturePage = {
  slug: 'mail',
  name: 'Mail',
  title: 'Gmail and Outlook in one inbox, with an agent on it.',
  lead: 'Read and send from every account in one place. Your agent drafts replies, clears out receipts and turns threads into tasks, and every change it makes can be undone.',
  worksWith: 'Works with Gmail and Outlook',
  metaTitle: 'Mail: Gmail and Outlook in one inbox',
  metaDescription:
    'One inbox for Gmail and Outlook. Replies drafted for you, send later, threads turned into tasks, and threads shared with your team in chat.',
  intro: [
    'Email is where customers, suppliers and partners say what they need. In most companies it sits in one person’s inbox, apart from the tasks, notes and records the rest of the team works from.',
    'In Native Intelligence your inbox sits beside your tasks, calendar, chat and CRM. Each thread links to the contacts in it, a thread becomes a task in one click, and the agent reads new mail as it lands, so it knows what changed without anyone forwarding anything.',
  ],
  sections: [
    {
      id: 'one-inbox',
      nav: 'One inbox',
      title: 'Every account in one inbox.',
      body: 'Connect as many Gmail and Outlook accounts as you use. Each one syncs on its own, and new mail shows up as it arrives. Read them all together, or pick one account from the side panel.',
      points: [
        'Read, star, archive, trash and label threads',
        'Inbox, starred, sent, drafts and your labels in one list',
        'Attachments shown on the message they came with',
        'Search your mail from the same box',
      ],
    },
    {
      id: 'reply-drafts',
      nav: 'Reply drafts',
      title: 'Replies drafted before you open the thread.',
      body: 'When mail arrives that needs an answer, the agent drafts a reply with what the workspace knows: the last call, the open tasks, the contact’s history. The draft waits in the thread with Send, Edit and Discard, so nothing goes out until you send it. Press Reply All on any thread and the assistant drafts one for you in the chat.',
      points: [
        'Drafts are written the way you write',
        'Drafts are saved in your own mailbox',
        'Change the recipients, subject and text before sending',
        'Ask for a shorter or warmer version in your own words',
      ],
    },
    {
      id: 'send-later',
      nav: 'Send later',
      title: 'Write it now, send it when it will be read.',
      body: 'Next to Send, pick tomorrow at 8:00 AM, next Monday at 8:00 AM, or any date and time. Scheduled messages wait in a Scheduled folder, where you can send one now or cancel it and keep it as a draft.',
    },
    {
      id: 'inbox-tidy',
      nav: 'Inbox tidy',
      title: 'Receipts and notices cleared each morning.',
      body: 'After your morning digest, the agent archives the day’s receipts, statements, shipping notices and alerts, and tells you in one message which senders it moved. Starred mail, drafts and anything waiting on your reply stay put. Press Undo and the batch comes back, and mail from those senders stays in your inbox from then on.',
      points: [
        'Ask the agent to archive, label, star or mute threads',
        'Unsubscribe from a mailing list in a sentence',
        'Every change says what it did and has an Undo',
      ],
    },
    {
      id: 'mail-to-tasks',
      nav: 'Threads to tasks',
      title: 'A thread becomes a task in one click.',
      body: 'Make a task from any email and it links back to the thread, so whoever picks it up can see where it came from. When a confirmation arrives that settles one of your open to-dos, like a booking or a delivery notice, the agent marks it done and tells you, with Undo.',
    },
    {
      id: 'share-to-chat',
      nav: 'Share to chat',
      title: 'Share a thread with your team without forwarding it.',
      body: 'Share an email thread into a channel or a direct message, with a note in your own words. Teammates in that conversation read it straight from your mailbox, and Native Intelligence keeps no copy of it. Undo removes the message and ends the share.',
    },
    {
      id: 'memory',
      nav: 'Shared memory',
      title: 'What your mail says reaches the rest of the workspace.',
      body: 'Each thread links to the contacts and companies in it and shows up on their record. The agent reads new mail as it arrives, tells you what you need to know, and when an email says a deal’s stage or a date changed, it updates the record, with the sentence that said so and an Undo.',
      demo: 'intelligence-loop',
    },
  ],
  faq: [
    {
      q: 'Do you keep a copy of our email?',
      a: 'No. The text of your mail is read live from Gmail or Outlook. The one exception is a thread the agent drafted a reply to: a copy waits beside the draft until you send or discard it, and is deleted after 14 days untouched.',
    },
    {
      q: 'Will the agent send email on its own?',
      a: 'No. Its replies are drafts, and nothing it writes for you goes out until you press Send. A message you schedule goes out at the time you picked, unless you cancel it first.',
    },
    {
      q: 'Can my teammates read my mail?',
      a: 'No. Your mailbox is yours. A teammate reads a thread only when you share it into a chat they are in, and Undo ends the share.',
    },
    {
      q: 'Can I connect more than one account?',
      a: 'Yes. Connect several Gmail and Outlook accounts and read them together in one inbox, or one at a time.',
    },
  ],
  related: ['crm', 'tasks', 'chat'],
}
