import type { FeaturePage } from './types'

export const docs: FeaturePage = {
  slug: 'docs',
  name: 'Docs',
  title: 'Docs your agents can read and edit.',
  lead: 'Write specs, plans and runbooks in a full editor, link them to projects, people and tables, and let agents keep them current. Every change is in the history, and any edit can be put back.',
  metaTitle: 'Docs: documents agents can read and edit',
  metaDescription:
    'Rich documents linked to projects, people and tables. Agents edit them section by section, and every version stays in the history to restore.',
  intro: [
    'A company’s docs go stale because updating them is nobody’s job. The spec says one thing, the last meeting decided another, and the new hire reads the wrong one.',
    'In Native Intelligence, docs live with the work they describe. An agent can edit one section without touching the rest, every change shows who made it, and the assistant answers questions from your docs with the source.',
  ],
  sections: [
    {
      id: 'editor',
      nav: 'Editor',
      title: 'A full editor for everything you write.',
      body: 'Headings, lists, tables, code blocks with highlighting, quotes, links and images. Type @ to mention a person or a record as a chip that opens it, and paste a table view’s link to show that table inside the doc.',
    },
    {
      id: 'agents-edit',
      nav: 'Agents edit',
      title: 'Agents edit one section at a time.',
      body: 'Ask an agent to update the pricing section and it changes that section only, found by its heading, and leaves the rest as it was. If someone edited the doc in the meantime, their change stays and the agent’s lands on top of it.',
      points: [
        'Add to a section, insert a new one or remove one',
        'Stage an edit as a draft for you to publish',
        'Suggestions you accept, dismiss or change in one click',
      ],
    },
    {
      id: 'history',
      nav: 'History',
      title: 'Every version kept, any edit undone.',
      body: 'The history lists every change to a doc, who it was for and what it did, with a line-by-line diff. Restore an earlier version, or revert just one edit to one section while every later edit stays.',
    },
    {
      id: 'linked-work',
      nav: 'Linked work',
      title: 'Docs attached to projects and tasks.',
      body: 'Attach a doc to a project or a task, pin the ones your team opens most, and archive the ones you no longer need. Docs link to each other, so a spec can point at the decisions behind it.',
    },
    {
      id: 'ask',
      nav: 'Ask your docs',
      title: 'Ask a question, get the answer with its source.',
      body: 'The assistant searches your docs alongside meetings, mail and chat, and says where it found each part of its answer. It can also summarize a long doc, or draft a new one from what the workspace knows.',
      demo: 'chat',
    },
    {
      id: 'comments',
      nav: 'Comments',
      title: 'Comment on the exact words.',
      body: 'Select text and leave a comment anchored to it, reply in a thread, and @mention a teammate to bring them in. Share a doc outside the workspace with a link that lets people read it, or read and comment.',
    },
  ],
  faq: [
    {
      q: 'Will an agent overwrite what we wrote?',
      a: 'An agent edits only the section it was asked to, and every edit is a new version. Restore the version before it, or revert just that one edit.',
    },
    {
      q: 'Can people outside the company read a doc?',
      a: 'Yes, with a share link that lets them read it, or read and comment.',
    },
    {
      q: 'Can a doc show live data?',
      a: 'Yes. Paste a table view’s link into a doc and the table shows inside it, with only the rows each reader is allowed to see.',
    },
    {
      q: 'Where do docs live?',
      a: 'In the drive, with your tables and files, and next to any project they belong to.',
    },
  ],
  related: ['drive', 'tables', 'agents'],
}
