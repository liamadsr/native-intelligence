'use client'

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { NodeSelection, TextSelection, Selection, Plugin, PluginKey } from '@tiptap/pm/state'
import { ProposalCard } from './proposal-card'
import { useProposalNodeContext } from './proposal-node-context'
import { SuggestionCard } from '@/components/suggestions/suggestion-card'

// --- React Component rendered inside the editor ---

function ProposalNodeComponent(props: ReactNodeViewProps) {
  const { node } = props
  const changeId = node.attrs.changeId as string
  const ctx = useProposalNodeContext()

  // No capture host (a document, docs/plans/suggestions-everywhere.md): the
  // suggestion card reads its row from the suggestions store itself.
  if (!ctx) {
    return (
      <NodeViewWrapper className="my-1" data-proposal-node>
        <div
          contentEditable={false}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest('button, [role="option"], [cmdk-item]')) e.stopPropagation()
          }}
        >
          <SuggestionCard id={changeId} />
        </div>
      </NodeViewWrapper>
    )
  }

  // O(1) via the provider's memoized map; linear fallback for providers that
  // don't build one (e.g. read-only share views).
  const change = ctx.changesById?.get(changeId) ?? ctx.changes.find((c) => c.id === changeId)
  if (!change) return null

  // Dismissed and expired proposals are hidden by ProposalCard itself, but also skip here
  if (change.status === 'dismissed' || change.status === 'expired') return null

  return (
    <NodeViewWrapper className="my-1" data-proposal-node>
      <div
        contentEditable={false}
        onMouseDown={(e) => {
          // Prevent editor from stealing focus when clicking proposal buttons
          if ((e.target as HTMLElement).closest('button, [role="option"], [cmdk-item]')) {
            e.stopPropagation()
          }
        }}
      >
        <ProposalCard
          change={change}
          onApply={ctx.onApply}
          onDismiss={ctx.onDismiss}
          onEdit={ctx.onEdit}
          onUndo={ctx.onUndo}
          onOpenEntity={ctx.onOpenEntity}
          members={ctx.members}
          aiMembers={ctx.aiMembers}
          contacts={ctx.contacts}
          projects={ctx.projects}
          currentMemberId={ctx.currentMemberId}
          autoAcceptPolicy={ctx.autoAcceptPolicy}
          readOnly={ctx.readOnly}
          onOpenSettings={ctx.onOpenSettings}
        />
      </div>
    </NodeViewWrapper>
  )
}

// --- Guard plugin: same pattern as LinkPreviewNode ---

const proposalNodeGuardPlugin = new Plugin({
  key: new PluginKey('proposalNodeGuard'),
  props: {
    handleTextInput(view, _from, _to, _text) {
      const { state } = view
      const { selection } = state
      if (selection instanceof NodeSelection && selection.node.type.name === 'proposalNode') {
        const pos = selection.from + selection.node.nodeSize
        const tr = state.tr
        const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(_text))
        tr.insert(pos, paragraph)
        tr.setSelection(TextSelection.create(tr.doc, pos + _text.length + 1))
        view.dispatch(tr)
        return true
      }
      return false
    },
    handleKeyDown(view, event) {
      const { state } = view
      const { selection } = state
      if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'proposalNode') {
        return false
      }
      const nodePos = selection.from
      const nodeSize = selection.node.nodeSize

      if (event.key === 'Enter') {
        const pos = nodePos + nodeSize
        const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, pos + 1))
        view.dispatch(tr)
        return true
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        // Don't allow deleting proposal nodes with keyboard
        return true
      }

      if (event.key === 'ArrowDown') {
        const afterPos = nodePos + nodeSize
        const tr = state.tr
        if (afterPos >= state.doc.content.size) {
          tr.insert(afterPos, state.schema.nodes.paragraph.create())
        }
        // Use Selection.near to safely resolve to nearest valid position
        // (handles consecutive atom nodes without throwing RangeError)
        tr.setSelection(Selection.near(tr.doc.resolve(afterPos), 1))
        view.dispatch(tr)
        return true
      }

      if (event.key === 'ArrowUp') {
        const tr = state.tr
        if (nodePos === 0) {
          tr.insert(0, state.schema.nodes.paragraph.create())
          tr.setSelection(TextSelection.create(tr.doc, 1))
        } else {
          // Use Selection.near to safely resolve to nearest valid position
          tr.setSelection(Selection.near(tr.doc.resolve(nodePos), -1))
        }
        view.dispatch(tr)
        return true
      }

      return false
    },
  },
})

// --- Tiptap Node Extension ---

export const ProposalNodeExtension = Node.create({
  name: 'proposalNode',
  group: 'block',
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-change-id'),
        renderHTML: (attributes) => ({ 'data-change-id': attributes.changeId }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-proposal-node]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-proposal-node': '' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ProposalNodeComponent)
  },

  addProseMirrorPlugins() {
    return [proposalNodeGuardPlugin]
  },
})
