import type { FeaturePage } from './types'

export const tables: FeaturePage = {
  slug: 'tables',
  name: 'Tables',
  title: 'Tables for anything your team keeps track of.',
  lead: 'Make a table for a pipeline, an inventory or a hiring plan, with the columns you need. Link rows to contacts and tasks, and let mail and meetings keep them up to date.',
  metaTitle: 'Tables: your team’s own databases',
  metaDescription:
    'Tables in the drive with typed columns, formulas, rollups and relations, shown as a grid, board, calendar or gallery, and kept current by agents.',
  intro: [
    'Every team keeps lists: suppliers, hires, orders, renewals. They live in spreadsheets nobody else can find, and they are out of date the week after someone builds them.',
    'Tables in Native Intelligence sit in the drive beside your docs. Their rows can link to contacts, deals and tasks, agents can read and write them, and when an email or a call says something changed, the row changes, with an Undo.',
  ],
  sections: [
    {
      id: 'columns',
      nav: 'Columns',
      title: 'Columns that know what they hold.',
      body: 'Give each column a type: text, number, currency, date, select, checkbox, person, email, phone, web address, or a relation to other records. Every value is checked against its column, so a number column only takes numbers.',
    },
    {
      id: 'formulas',
      nav: 'Formulas',
      title: 'Formulas and rollups, worked out as you read.',
      body: 'Write a formula over a row’s other columns, like {Price} * {Qty}, or roll up the records a relation links to: a count, a sum, an average, the latest date. Rename a column and the formulas that use it keep working.',
    },
    {
      id: 'layouts',
      nav: 'Layouts',
      title: 'A grid, a board, a calendar or a gallery.',
      body: 'Save views of the same table, each with its own layout, filters, sorts and grouping. Drag a card between lanes on a board, or between days on a calendar, and the row changes with it.',
    },
    {
      id: 'relations',
      nav: 'Relations',
      title: 'Rows that link to the rest of the workspace.',
      body: 'A relation column links a row to contacts, companies, deals, tasks or rows in another table. Deals work the same way: a pipeline is a table whose rows are deals.',
    },
    {
      id: 'kept-current',
      nav: 'Kept current',
      title: 'Rows that update from mail and meetings.',
      body: 'When an email or a call involving a linked contact says a date moved, an amount changed or a box should be ticked, the row changes. You get one message with what changed and the sentence behind it, and one click puts it back.',
    },
    {
      id: 'agents',
      nav: 'Agents',
      title: 'Agents read and write rows for you.',
      body: 'Ask the agent to find the overdue rows, add ten new ones or change a column. Every change is one entry in the table’s history, and Undo takes it back field by field, keeping anything changed since.',
    },
    {
      id: 'import-export',
      nav: 'Import and export',
      title: 'In from a spreadsheet, out as CSV.',
      body: 'Bring in a CSV or XLSX file, map each column, and the whole import lands as one change that one Undo takes back. Export any view as CSV, with its filters and columns.',
      points: [
        'Start blank, or from a template like Pipeline, Inventory or Job tracker',
        'Templates come with example rows you can delete',
        'A cell that doesn’t fit its column is left empty and counted, not refused',
      ],
    },
  ],
  faq: [
    {
      q: 'How is this different from a spreadsheet?',
      a: 'Each column has a type, rows can link to contacts, deals and tasks, and agents keep rows current from mail and meetings. Every change is in the history and can be undone.',
    },
    {
      q: 'Can I put a table in a doc?',
      a: 'Yes. Paste a view’s link into a doc and the table shows there, with only the rows each reader may see.',
    },
    {
      q: 'Who can see a table?',
      a: 'A table is open to the whole workspace, or private to you.',
    },
    {
      q: 'How much does it cost?',
      a: 'Start with a 7-day free trial. The pricing page has the details.',
    },
  ],
  related: ['crm', 'docs', 'drive'],
}
