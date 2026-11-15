import type { FeaturePage } from './types'

export const mcp: FeaturePage = {
  slug: 'mcp',
  name: 'MCP',
  title: 'Bring your own AI to your workspace.',
  lead: 'Claude, ChatGPT, Cursor and other AI tools can read and act on your workspace over MCP. They see the same calls, tasks, docs and customers your team does.',
  worksWith: 'Works with Claude, ChatGPT, Cursor and other MCP clients',
  metaTitle: 'MCP: connect Claude, ChatGPT and Cursor',
  metaDescription:
    'Connect Claude, ChatGPT, Cursor and other MCP clients to your workspace. Sign in with your account, choose read or write, revoke access any time.',
  intro: [
    'Many people already have an AI tool they like. The trouble is that it knows nothing about the company: not the call from Tuesday, not the open tasks, not the customer’s last email. Every question starts with a paste.',
    'The workspace’s MCP server closes that gap. Connect the tool you use, sign in with your Native Intelligence account, and it can search the shared memory, read and update tasks and docs, and save what it learns back with its source.',
  ],
  sections: [
    {
      id: 'connect',
      nav: 'Connect',
      title: 'Connect in a minute.',
      body: 'Open Settings › NI MCP and pick your app. Some apps install in one click, some take one command, and the rest take the server address pasted in their settings.',
      points: [
        'Cursor installs in one click',
        'Claude and ChatGPT connect with the server address',
        'Any MCP client that signs in this way works too',
      ],
    },
    {
      id: 'sign-in',
      nav: 'Sign in',
      title: 'You sign in. No key to copy.',
      body: 'The app opens a Native Intelligence sign-in page that says what it is asking for: reading your workspace, or reading and making changes. Approve it or deny it. The app reaches only workspaces you belong to.',
    },
    {
      id: 'tools',
      nav: 'Tools',
      title: 'The same tools as the chat.',
      body: 'The tools behind the workspace’s own assistant are the ones your AI app gets: search, tasks, projects, docs, tables, meetings, mail, calendar, contacts and more.',
      points: [
        'Search calls, mail, docs and tasks at once',
        'Create and update tasks, docs and records',
        'Read a meeting’s notes and transcript',
      ],
    },
    {
      id: 'memory',
      nav: 'Memory',
      title: 'It reads the shared memory.',
      body: 'The server teaches the app to look in the workspace’s memory first: facts, decisions and open questions, each with its source. What the app establishes while it works, it can save back with a quote from where it came from.',
    },
    {
      id: 'workspaces',
      nav: 'Workspaces',
      title: 'One connection, every workspace.',
      body: 'If you belong to more than one workspace, one connection reaches all of them. Each item carries its workspace, and a new one is created where you mean it.',
    },
    {
      id: 'revoke',
      nav: 'Revoke',
      title: 'Take access back any time.',
      body: 'Settings › NI MCP lists the apps you have connected. Revoke one and it can no longer reach your workspace.',
    },
    {
      id: 'other-way',
      nav: 'The other way',
      title: 'Add other apps’ tools to your agents.',
      body: 'It works the other way too. In Settings › Connectors, connect an app’s own MCP server, such as Linear or Attio, and the workspace’s agent can use its tools. Set each tool to always allow, needs approval or blocked.',
    },
  ],
  faq: [
    {
      q: 'Which AI apps work?',
      a: 'Claude, ChatGPT and Cursor, and other MCP clients that sign in with OAuth. Settings › NI MCP shows how to add each one.',
    },
    {
      q: 'Can I connect an app that only reads?',
      a: 'Yes. The sign-in page shows whether the app asks to read only, or to read and make changes, before you approve it.',
    },
    {
      q: 'What happens if I stop using the app?',
      a: 'Revoke its access in Settings › NI MCP. It can no longer reach your workspace.',
    },
    {
      q: 'Do I need an API key?',
      a: 'No. Your AI app signs in with your Native Intelligence account.',
    },
  ],
  related: ['agents', 'skills', 'drive'],
}
