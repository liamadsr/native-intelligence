import React, { useCallback, useEffect, useRef, useState } from 'react';
import { handOffToHome } from '@/lib/chat/home-thread-client';
import { studioWorkspaceId } from '../studio-env';

// The Studio has no assistant of its own: the workspace's agent edits videos with the Studio tools
// (src/lib/ai/tools/studio.ts), in the person's one conversation with it. This panel is a way to ask it from
// where the person is working: what they type goes to that conversation as their own message, with one line
// saying which video is open and where the playhead is, so "zoom in here" means something. The agent's edit is
// saved on the server, and the editor takes it up as one step that Undo reverts (App.tsx watches the video's
// digest), so the answer shows up in the preview and the timeline, not in this panel.

const suggestions = ['Add a title card at the start that says the product name', 'Zoom in on every click in the app sections', 'Show the camera full screen for the intro', 'Add a lower-third with my name when I first appear'];

/** What the agent is told about where the person is, after their words. */
export function videoContextLine({ projectId, title, playheadSeconds, selectedClipIds }: { projectId: string; title: string; playheadSeconds: number; selectedClipIds: string[] }): string {
  const parts = [`Studio video "${title}"`, `video_id ${projectId}`, `playhead at ${playheadSeconds.toFixed(1)} s`];
  if (selectedClipIds.length) parts.push(`selected clips: ${selectedClipIds.slice(0, 12).join(', ')}`);
  return `(${parts.join('; ')})`;
}

/** Ask the workspace's agent to change the open video. */
export function AgentPanel({ projectId, title, playheadSeconds, selectedClipIds, beforeSend, brief, onBriefSent }: {
  projectId: string; title: string; playheadSeconds: number; selectedClipIds: string[];
  /** Saves the edit first, so the agent works on what the person sees. False: it could not be saved. */
  beforeSend: () => Promise<boolean>;
  /** Kept so the editor's call site stays as it was: the editor notices the agent's saves on its own. */
  onProjectChanged?: () => void;
  /** A brief from New project: sent once as the first message. */
  brief?: string; onBriefSent?: () => void;
}) {
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState<string | null>(null), [sent, setSent] = useState<string | null>(null);
  const where = useRef({ projectId, title, playheadSeconds, selectedClipIds });
  where.current = { projectId, title, playheadSeconds, selectedClipIds };
  const send = useCallback(async (text: string) => {
    const words = text.trim(); if (!words) return false;
    setSending(true); setError(null);
    try {
      if (!(await beforeSend())) { setError('Save your edit before asking the agent.'); return false; }
      const result = await handOffToHome({ text: `${words}\n\n${videoContextLine(where.current)}`, workspaceId: studioWorkspaceId() });
      if (!result.ok) { setError(result.reason); return false; }
      setSent(words); return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setSending(false); }
  }, [beforeSend]);
  // A brief typed while making the video is its first message, once.
  const briefSent = useRef<string | null>(null);
  useEffect(() => { if (!brief || briefSent.current === `${projectId}:${brief}`) return; briefSent.current = `${projectId}:${brief}`; void send(brief).then(ok => { if (ok) onBriefSent?.(); }); }, [brief, projectId, send, onBriefSent]);
  const submit = () => { const text = draft; void send(text).then(ok => { if (ok) setDraft(''); }); };
  return <div className="inspector agent-panel">
    <header className="agent-head"><h2>Agent</h2></header>
    <div className="agent-empty">
      <p>Ask your agent to change this video: titles, animations, shots, zooms, pacing, the script or the storyboard. It answers in your conversation with it, and its edit lands here as one step you can undo.</p>
      <div className="agent-suggestions">{suggestions.map(s => <button key={s} disabled={sending} onClick={() => void send(s)}>{s}</button>)}</div>
    </div>
    {sent ? <div className="agent-messages" aria-live="polite"><div className="agent-msg agent-user">{sent}</div><div className="agent-msg agent-status">Sent to your agent. Watch the preview: its changes arrive here.</div></div> : null}
    {error ? <p className="rec-error agent-error" role="alert">{error}</p> : null}
    <div className="agent-compose">
      <textarea aria-label="Message your agent" rows={3} placeholder={sending ? 'Sending…' : 'Describe a change… (Enter to send)'} value={draft} disabled={sending}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
      <div className="agent-foot"><span /><button className="primary agent-send" disabled={sending || !draft.trim()} onClick={submit}>Send</button></div>
    </div>
  </div>;
}
