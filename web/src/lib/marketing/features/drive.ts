import type { FeaturePage } from './types'

export const drive: FeaturePage = {
  slug: 'drive',
  name: 'Drive',
  title: 'Docs, tables and files in one drive.',
  lead: 'Write docs, keep tables of anything, and find every file the team has uploaded, in one place your agents can read and edit too.',
  metaTitle: 'Drive: docs, tables and files in one place',
  metaDescription:
    'Docs with comments and version history, tables with typed columns and views, and every uploaded file, in one drive your agents can read and edit.',
  intro: [
    'Specs live in one tool, trackers in a spreadsheet, and the PDF a customer sent sits in an email thread. When someone asks where the latest version is, the answer is a search across three apps.',
    'The drive keeps them together and joined to the rest of the work. A doc belongs to a project, a table row can link to a contact or a task, and a file stays attached to the meeting or task it came with. Because it is all in the workspace’s memory, an agent can find it, read it and keep it current.',
  ],
  sections: [
    {
      id: 'docs',
      nav: 'Docs',
      title: 'Docs for specs, plans and notes.',
      body: 'A full editor with headings, lists, code blocks, links, images, quotes and tables. Link a doc to a project, pin the ones that matter and archive the ones you are done with.',
      points: [
        'Inline comments on any selection, with threads and @mentions',
        'Share links that allow viewing or commenting',
        'Found from search with everything else',
      ],
    },
    {
      id: 'history',
      nav: 'History',
      title: 'Every change, and a way back.',
      body: 'A doc’s history lists every change to its title or body, newest first, with who made it. See what a change did, restore an earlier version, or undo one edit to one section and keep the rest.',
    },
    {
      id: 'agents-edit',
      nav: 'Agent edits',
      title: 'Agents edit in plain view.',
      body: 'When an agent edits a doc, the change applies at once and shows in the history with where it came from. An edit that rested on text from a web page carries a label, so it is easy to spot and undo.',
    },
    {
      id: 'tables',
      nav: 'Tables',
      title: 'Tables for lists and trackers.',
      body: 'Rows under typed columns: text, numbers, dates, choices, people, money, links to other records, formulas and rollups. Look at the same table as a grid, a board, a calendar or a gallery.',
      points: [
        'Bring in a CSV, TSV or Excel file and map its columns',
        'Link a row to a contact, company, task, project, doc or meeting',
        'Every change is in the table’s history, with Undo',
      ],
    },
    {
      id: 'files',
      nav: 'Files',
      title: 'Every file, in one list.',
      body: 'The Files page shows every file uploaded to a meeting, a task or a project, so the attachment someone shared last month is one search away.',
    },
    {
      id: 'knowledge',
      nav: 'Knowledge',
      title: 'Facts and decisions, each with its source.',
      body: 'Knowledge shows the facts, decisions and open questions drawn from your calls, mail and docs, each with the place it came from. It is the memory every agent reads before it acts.',
      demo: 'intelligence-loop',
    },
  ],
  faq: [
    {
      q: 'Can agents change our docs and tables?',
      a: 'Yes, when you ask or when a call or email clearly changes something. Each change shows in the doc’s or table’s history with where it came from, and you can undo it there.',
    },
    {
      q: 'Can I share a doc with someone outside the team?',
      a: 'Yes. Make a share link that allows viewing or commenting.',
    },
    {
      q: 'Can we bring our spreadsheets in?',
      a: 'Yes. Import a CSV, TSV or Excel file into a table, map each column, check the first rows, and import. One Undo takes the whole import back.',
    },
  ],
  related: ['docs', 'tables', 'agents'],
}
