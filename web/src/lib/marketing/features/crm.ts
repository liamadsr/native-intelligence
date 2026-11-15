import type { FeaturePage } from './types'

export const crm: FeaturePage = {
  slug: 'crm',
  name: 'CRM',
  title: 'A CRM without data entry.',
  lead: 'Companies, contacts and deals build up from your mail, meetings and calendar. Notes, history and deal stages stay current without anyone logging them.',
  worksWith: 'Bring your list over from HubSpot or a spreadsheet',
  metaTitle: 'CRM: companies, contacts and deals',
  metaDescription:
    'A built-in CRM whose contacts, companies and deals fill in from your mail, meetings and calendar. Bring your list over from HubSpot or a spreadsheet.',
  intro: [
    'A CRM is only as good as what people type into it, and after a busy week nobody types much. The history of an account ends up spread across inboxes, call notes and people’s heads.',
    'Native Intelligence keeps the record from the work itself. Mail links to the people in it, meetings land on the contacts who were there, and when a call or an email says a deal moved, the deal moves, with an Undo.',
  ],
  demo: 'crm-autolog',
  sections: [
    {
      id: 'contacts',
      nav: 'Contacts',
      title: 'Contacts with their whole history.',
      body: 'Every contact has a timeline of the meetings they were in, the email threads they are on and the tasks about them, built as you work. Add notes, tags, a relationship type and a follow-up date, and the agent reminds you when one comes due.',
      points: [
        'Contacts from mail and calendar invites, linked by email address',
        'Private, team or workspace visibility for each contact',
        'Comments with @mentions on any record',
      ],
    },
    {
      id: 'companies',
      nav: 'Companies',
      title: 'Companies that gather their people.',
      body: 'Contacts group under their company, matched by its web domain, so one page shows every relationship you have there. A company keeps its industry, size and description beside the activity of everyone who works there.',
    },
    {
      id: 'deals',
      nav: 'Deals',
      title: 'Deals in pipelines you shape.',
      body: 'A pipeline holds your deals in stages you name, shown as a board you drag cards across. Add the fields your team tracks, from amounts and dates to owners and links to contacts.',
    },
    {
      id: 'kept-current',
      nav: 'Kept current',
      title: 'Records that update from mail and meetings.',
      body: 'When an email or a call says something changed, like a stage, a date or an amount, the record linked to those people changes too. You get one message with what changed and the sentence that said it, with Undo, and a change you undo is not made again.',
      points: [
        'Only a change the mail or call states plainly is made',
        'A won or lost deal is only reopened by a person',
        'Every change is in the record’s history',
      ],
    },
    {
      id: 'voice-id',
      nav: 'Voice ID',
      title: 'Know who spoke on every call.',
      body: 'With the Mac app, speakers in a meeting are matched to their contacts by voice. Each correction teaches it, so it grows more sure of each person over time.',
    },
    {
      id: 'import',
      nav: 'Import',
      title: 'Bring your list in from a spreadsheet.',
      body: 'Send a CSV, XLSX or vCard file and the agent maps the columns, matches people you already have and fills in what is missing without writing over your own edits. A whole import comes back out with one Undo.',
    },
    {
      id: 'switching',
      nav: 'Switching',
      title: 'Bring your CRM with you.',
      body: 'Connect HubSpot once and your companies and contacts come across. From then on the record is updated from your mail, meetings and calendar, so there is no second CRM to keep in step.',
    },
  ],
  faq: [
    {
      q: 'Do we need another CRM alongside it?',
      a: 'No. This is the CRM. Bring your companies and contacts over from HubSpot or a spreadsheet and work from here.',
    },
    {
      q: 'Will it change records we edited by hand?',
      a: 'An import fills in what is empty and never writes over your own fields. A change made from mail or a meeting comes with Undo, and once you undo it, it is not made again.',
    },
    {
      q: 'Who can see a contact?',
      a: 'Each contact is private, open to chosen teams, or open to the whole workspace, and can be shared with a person or a team to view or to edit.',
    },
    {
      q: 'Does it look people up on the web by itself?',
      a: 'Only when someone asks it to. The one exception is when you sign up: it reads up on you and your own company, so it starts out knowing who you are.',
    },
  ],
  related: ['mail', 'meetings', 'tables'],
}
