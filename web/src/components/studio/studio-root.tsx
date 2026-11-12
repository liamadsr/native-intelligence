'use client'

/**
 * The Studio, mounted: the editor app (./ui) inside the one element its stylesheet and its keyboard handlers are
 * scoped to (./studio-env.ts, ./ui/studio.css).
 *
 * The editor reads media by address while it previews, so before it mounts it is told where this workspace's
 * files are served from; a workspace switch remounts it (the key), since everything it holds (the open video, its
 * undo history, the library) belongs to the workspace it was opened in.
 *
 * If something in the editor breaks, the page says so with a way back instead of going blank: the edit is saved
 * on the server after every change.
 */
import './ui/media-budget'
import * as React from 'react'
import { setAssetBase } from '@/lib/studio/engine/asset-base'
import { App } from './ui/App'
import { ContextMenuProvider } from './ui/ContextMenu'
import { setStudioRoot, setStudioWorkspace, studioFileBase } from './studio-env'
import './ui/studio.css'
import './ui/studio-shell.css'

class Recover extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[studio] the editor crashed:', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="studio-recover">
        <h2>Something in the Studio broke</h2>
        <p>
          Your work is saved. Open it again to carry on. If it keeps happening, tell the agent this line:{' '}
          <code>{String(this.state.error.message).slice(0, 300)}</code>
        </p>
        <button className="primary" onClick={() => this.setState({ error: null })}>
          Open it again
        </button>
      </div>
    )
  }
}

/** A video's pages, and 'project' for the Studio project it is in. */
export type StudioPage = 'project' | 'overview' | 'storyboard' | 'cast' | 'edit'

export interface StudioRootProps {
  workspaceId: string
  /** The video to open on (a link to one video, the agent showing one); absent: where the person left off. */
  videoId?: string | null
  /** The page of that video to open on. */
  page?: StudioPage
  /** Which request `videoId` and `page` are: a new number asks again, even for the same place (the Studio may have moved away since). */
  ask?: number
  /**
   * The Studio page's sub-nav beside the rail is its navigation now (page-panel/studio-panel.tsx): the editor draws
   * no rail and no Projects entry of its own. Off: as a page of its own, with its rail.
   */
  navInPanel?: boolean
  /** Told which video is open and on which page, whenever that changes. */
  onPlace?: (place: { videoId: string | null; title: string | null; page: StudioPage }) => void
}

export default function StudioRoot({ workspaceId, videoId, page, ask, navInPanel = false, onPlace }: StudioRootProps) {
  // Set while rendering, before the editor's first read of a media address.
  setAssetBase(studioFileBase(workspaceId))
  setStudioWorkspace(workspaceId)
  const rootRef = React.useCallback((element: HTMLDivElement | null) => setStudioRoot(element), [])
  return (
    <div ref={rootRef} className="ni-studio ni-studio-root" data-studio-root="" data-studio-nav={navInPanel ? 'panel' : 'rail'}>
      <Recover key={workspaceId}>
        <ContextMenuProvider>
          <App key={workspaceId} openVideoId={videoId ?? null} openPage={page} openAsk={ask} navInPanel={navInPanel} onPlace={onPlace} />
        </ContextMenuProvider>
      </Recover>
    </div>
  )
}
