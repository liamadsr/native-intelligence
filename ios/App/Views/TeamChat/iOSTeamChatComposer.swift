//
//  iOSTeamChatComposer.swift
//  Native Intelligence
//
//  Team chat's composer: the words (an "@" lists the members and the
//  person's own agent to pick), files from Photos or Files (uploaded as soon
//  as they are picked, shown as chips), the typing line above, and an edit
//  of the person's own message in place.
//

import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct iOSTeamChatComposer: View {
    @ObservedObject var model: TeamChatConversationModel
    let placeholder: String

    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var colorScheme

    private var cardFill: Color {
        colorScheme == .dark ? Color(UIColor(red: 0.141, green: 0.141, blue: 0.149, alpha: 1)) : Color(.secondarySystemBackground)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            let candidates = model.mentionCandidates
            if !candidates.isEmpty { mentionPicker(candidates) }
            if let line = model.typingLine {
                Text(line)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }
            if !model.canPost {
                Text("This channel is archived.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            } else {
                card
            }
        }
        // Its own ground: the typing line and the card never sit over the messages scrolling under them.
        .background(TeamChatStyle.background.ignoresSafeArea(edges: .bottom))
        .animation(.easeOut(duration: 0.15), value: model.typingLine)
        .photosPicker(isPresented: $showingPhotos, selection: $photoItems, maxSelectionCount: TeamChatFiles.maxFiles, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            for item in items { Task { await attachPhoto(item) } }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: Self.fileTypes, allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            for url in urls { attachFile(url) }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let editing = model.editing {
                HStack {
                    Label("Editing your message", systemImage: "pencil").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { model.cancelEdit() }.font(.system(size: 13, weight: .semibold))
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .id(editing.id)
            }
            if !model.attachments.isEmpty || model.uploading > 0 { attachmentChips }
            TextField(placeholder, text: $model.draft, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($focused)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 4)
            HStack(spacing: 4) {
                if model.editing == nil {
                    Menu {
                        Button { showingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                        Button { showingFiles = true } label: { Label("Files", systemImage: "folder") }
                    } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                            .frame(width: 40, height: 40)
                    }
                    .accessibilityLabel("Attach")
                }
                Button {
                    model.draft = model.draft.isEmpty || model.draft.hasSuffix(" ") || model.draft.hasSuffix("\n") ? model.draft + "@" : model.draft + " @"
                    focused = true
                } label: {
                    Image(systemName: "at")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel("Mention someone")
                Spacer()
                Button {
                    model.send()
                } label: {
                    Image(systemName: model.editing == nil ? "arrow.up" : "checkmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(model.canSend ? Color(.systemBackground) : Color.secondary)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(model.canSend ? Color.primary : Color(.tertiarySystemFill)))
                }
                .disabled(!model.canSend)
                .accessibilityLabel(model.editing == nil ? "Send" : "Save edit")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
            // Monochrome like the chat's composer: the accent is kept for mentions.
            .tint(Color.secondary)
        }
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(cardFill))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color(.separator).opacity(0.35), lineWidth: 0.5))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.attachments, id: \.path) { a in
                    HStack(spacing: 5) {
                        Image(systemName: a.isImage ? "photo" : "doc").font(.system(size: 11)).foregroundStyle(.secondary)
                        Text(a.name).font(.caption).lineLimit(1).foregroundStyle(.primary)
                        Button { model.removeAttachment(a) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(a.name)")
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                }
                if model.uploading > 0 {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(model.uploading == 1 ? "Uploading…" : "Uploading \(model.uploading)…").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
        }
    }

    private func mentionPicker(_ candidates: [TeamChatPickedMention]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(candidates.enumerated()), id: \.offset) { _, c in
                Button {
                    model.pick(c)
                } label: {
                    HStack(spacing: 10) {
                        TeamChatAvatar(member: c.memberId.flatMap { model.store.members[$0] }, agent: c.memberId == nil, size: 28)
                        Text(c.label).font(.system(size: 16)).foregroundStyle(.primary)
                        if c.memberId == nil {
                            Text("your agent").font(.system(size: 13)).foregroundStyle(.secondary)
                        } else if c.memberId == model.me {
                            Text("you").font(.system(size: 13)).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(TeamChatStyle.card))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color(.separator).opacity(0.35), lineWidth: 0.5))
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    // MARK: Files

    private static let fileTypes: [UTType] = TeamChatFiles.types.keys.compactMap { UTType(filenameExtension: $0) }

    /// A photo goes as a JPEG (every screen draws it), its own size kept so it takes its room before it loads.
    private func attachPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            model.errorMessage = "That photo couldn’t be read."
            return
        }
        let scaled = Self.fitting(image, longest: 2048)
        guard let jpeg = scaled.jpegData(compressionQuality: 0.85) else { return }
        let w = Int(scaled.size.width * scaled.scale), h = Int(scaled.size.height * scaled.scale)
        model.attach(data: jpeg, name: "Photo.jpg", type: "image/jpeg", width: w, height: h)
    }

    private func attachFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            model.errorMessage = "That file couldn’t be read."
            return
        }
        let name = url.lastPathComponent
        guard let type = TeamChatFiles.type(of: name) else {
            model.errorMessage = TeamChatFiles.refusal(name: name, size: data.count)
            return
        }
        var w: Int?, h: Int?
        if TeamChatFiles.isInlineImage(path: name), let image = UIImage(data: data) {
            w = Int(image.size.width * image.scale)
            h = Int(image.size.height * image.scale)
        }
        model.attach(data: data, name: name, type: type, width: w, height: h)
    }

    private static func fitting(_ image: UIImage, longest: CGFloat) -> UIImage {
        let size = image.size
        let scale = min(1, longest / max(size.width, size.height))
        guard scale < 1 else { return image }
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }
}
