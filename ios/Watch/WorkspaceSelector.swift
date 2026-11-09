import SwiftUI

/// The idle screen's secondary line: WHICH WORKSPACE this watch will file its
/// next capture into.
///
/// It replaces the old product-name label, which said nothing. People belong to more
/// than one workspace, and a capture made on the wrist has to land in the right
/// one — but the record button is still the hero of this screen, so the selector
/// is deliberately quiet: footnote type, secondary colour, no fill of its own.
///
/// WHY A `Picker` WITH `.navigationLink` STYLE. Apple's watchOS guidance for
/// choosing one item from a short list is exactly this control: it renders the
/// current value inline as a button, opens a one-level list on tap, and — the
/// part a hand-rolled `NavigationLink` + `List` cannot do — lets the DIGITAL
/// CROWN scrub the options while the row is focused, without any tap at all.
/// One level deep, glanceable, crown-first.
///
/// THREE STATES, and only the first is interactive:
///   • more than one workspace → the picker;
///   • exactly one            → a plain label (mirrors iOS, where the switcher
///                              hides entirely with ≤1 workspace: offering a
///                              choice of one is a dead end);
///   • no list yet            → the neutral app name, non-interactive. NEVER a
///                              spinner and never an error: a watch that has not
///                              yet heard from its phone is a normal state, the
///                              recording still works, and the phone files it
///                              into whatever workspace is active there.
///
/// It is only ever mounted on the IDLE screen — while recording or paused the
/// screen shows the capture layout, which has no selector at all. That is design
/// point 3 made structural rather than a disabled-state flag: a capture in flight
/// cannot change workspace because the control does not exist then.
struct WorkspaceSelector: View {
    @ObservedObject private var sync = WatchSync.shared

    /// Neutral, deliberately. The system's default accent would tint the
    /// disclosure chevron and the list's checkmark green or blue; this screen is
    /// charcoal and white and stays that way.
    private static let neutralTint = Color(white: 0.78)

    var body: some View {
        if sync.workspaces.count > 1 {
            picker
        } else if let only = sync.workspaces.first {
            plainLabel(only.name)
        } else {
            plainLabel("NI")
        }
    }

    // MARK: - Interactive

    private var picker: some View {
        Picker(selection: selection) {
            ForEach(sync.workspaces) { workspace in
                // ⚠️ ONE LINE, AND IT HAS TO STAY ONE LINE. In a `.navigationLink`
                // Picker the option row view IS ALSO the collapsed value view, so
                // anything that wraps here wraps the pill on the idle screen too —
                // verified by screenshot: dropping the line limit turned the pill
                // into a full-width two-line block that swamped the mic button.
                //
                // The slug therefore sits BESIDE the name rather than under it,
                // and carries the layout priority: when the row is too narrow the
                // NAME truncates and the disambiguator survives, which is the only
                // ordering that makes the row worth showing at all.
                HStack(spacing: 5) {
                    Text(workspace.name)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if needsSlug, let slug = workspace.slug {
                        Text(slug)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                .tag(workspace.id)
            }
        } label: {
            EmptyView()
        }
        .pickerStyle(.navigationLink)
        .labelsHidden()
        // `.small`, not `.mini`. `.mini` drew a 33pt-tall pill: under Apple's 44pt
        // minimum, and 10pt below a 92pt button that starts a recording — the two
        // likeliest mistaps on this screen are "meant to switch workspace, started
        // recording" and the reverse. A Picker's hit region is its own control
        // frame, so padding on the outside would not have bought anything; the
        // control itself has to be bigger.
        .controlSize(.small)
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .tint(Self.neutralTint)
        .fixedSize()
        // VoiceOver would otherwise read a bare workspace name with no hint that
        // it is a control, let alone which one.
        .accessibilityLabel("Workspace")
        .accessibilityValue(currentLabel)
    }

    /// True when at least two workspaces share a name, so the slug has to be shown
    /// to tell them apart. Mirrors `needsSlugToDisambiguate` in iOS Settings — the
    /// signup trigger names a workspace after its owner, so a person with two of
    /// them sees two identical rows otherwise.
    private var needsSlug: Bool {
        let names = sync.workspaces.map {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        return Set(names).count < names.count
    }

    /// What the collapsed pill (and VoiceOver) says for the current choice. When
    /// the names collide the SLUG is what identifies it, and the slug is short
    /// enough to fit where a truncated duplicate name would not.
    private var currentLabel: String {
        let id = selection.wrappedValue
        guard let workspace = sync.workspaces.first(where: { $0.id == id }) else { return "" }
        if needsSlug, let slug = workspace.slug { return "\(workspace.name), \(slug)" }
        return workspace.name
    }

    /// The current choice, resolved through `WatchSync` so a selection that is no
    /// longer a membership falls back instead of showing a dead name. Writing it
    /// persists immediately — the choice has to survive a relaunch.
    private var selection: Binding<UUID> {
        Binding(
            get: {
                // Resolve against the PUBLISHED list this view is rendering, not
                // just the authoritative one: `WatchSync` updates its stored copy
                // synchronously and its `@Published` mirror on the next main-queue
                // turn, so for one turn after a push the resolved id can name a
                // workspace the ForEach above has not listed yet — and a Picker
                // whose selection matches no tag renders blank.
                let resolved = sync.effectiveWorkspaceId
                if let resolved, sync.workspaces.contains(where: { $0.id == resolved }) {
                    return resolved
                }
                return sync.workspaces.first?.id ?? UUID()
            },
            set: { sync.selectWorkspace($0) }
        )
    }

    // MARK: - Non-interactive

    /// Exactly the type the old product-name label used, so the idle screen's rhythm
    /// is unchanged when there is nothing to choose.
    private func plainLabel(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 10)
            // Reads the same way as the interactive state, so VoiceOver users get
            // "Workspace, <name>" whether or not there is a choice to make.
            .accessibilityLabel("Workspace")
            .accessibilityValue(text)
    }
}
