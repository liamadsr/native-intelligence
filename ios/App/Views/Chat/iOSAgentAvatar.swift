import SwiftUI
import WebKit

/// The same bundled canvas rig as the website, with no network access or auth.
struct iOSAgentAvatar: UIViewRepresentable {
    let character: String
    var working = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let web = Self.makeWebView()
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        Self.load(web)
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.config = ["character": character, "working": working, "reduceMotion": reduceMotion,
                                       "paused": scenePhase != .active, "dark": colorScheme == .dark]
        context.coordinator.render()
    }
    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.evaluateJavaScript("window.setBot && window.setBot({character:'chat',paused:true})")
        web.stopLoading()
        web.navigationDelegate = nil
    }
    fileprivate static func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.isAccessibilityElement = false
        return web
    }
    fileprivate static func load(_ web: WKWebView) {
        let url = Bundle.main.url(forResource: "EveBotAvatar", withExtension: "html")
            ?? Bundle.main.url(forResource: "EveBotAvatar", withExtension: "html", subdirectory: "Resources")
        if let url, let html = try? String(contentsOf: url, encoding: .utf8) { web.loadHTMLString(html, baseURL: nil) }
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var web: WKWebView?
        var ready = false
        var config: [String: Any] = [:]
        private var lastJSON: String?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; render() }
        func render() {
            guard ready, let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]),
                  let json = String(data: data, encoding: .utf8), json != lastJSON else { return }
            lastJSON = json
            web?.evaluateJavaScript("window.setBot(\(json))")
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
        }
    }
}

/// One offscreen renderer caches stills for the picker; rows are native Images,
/// so opening a list does not start a WebKit instance/animation for every bot.
@MainActor
private final class AgentThumbnailCache: NSObject, ObservableObject, WKNavigationDelegate {
    static let shared = AgentThumbnailCache()
    @Published var images: [String: UIImage] = [:]
    private lazy var web = iOSAgentAvatar.makeWebView()
    private var ready = false
    private var rendering = false
    private var queue: [String] = []
    private var loaded = false

    func request(_ character: String) {
        guard images[character] == nil, !queue.contains(character) else { return }
        queue.append(character)
        if !loaded {
            loaded = true
            web.navigationDelegate = self
            iOSAgentAvatar.load(web)
        }
        renderNext()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; renderNext() }
    private func renderNext() {
        guard ready, !rendering, let key = queue.first,
              let data = try? JSONSerialization.data(withJSONObject: ["character": key, "paused": true]),
              let json = String(data: data, encoding: .utf8) else { return }
        rendering = true
        web.evaluateJavaScript("window.setBot(\(json)); document.querySelector('canvas').toDataURL('image/png')") { [weak self] value, _ in
            guard let self else { return }
            if let url = value as? String, let encoded = url.split(separator: ",").last,
               let bytes = Data(base64Encoded: String(encoded)), let image = UIImage(data: bytes) { self.images[key] = image }
            self.queue.removeFirst()
            self.rendering = false
            self.renderNext()
        }
    }
}

struct iOSAgentThumbnail: View {
    let agent: iOSChatAgent?
    @ObservedObject private var cache = AgentThumbnailCache.shared
    var body: some View {
        Group {
            if let character = agent?.character, let image = cache.images[character] {
                Image(uiImage: image).resizable().scaledToFit().scaleEffect(1.35)
            } else if let url = agent?.avatarURL {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { fallback }
                    .clipShape(Circle())
            } else { fallback }
        }
        .task(id: agent?.character) { if let character = agent?.character { cache.request(character) } }
        .accessibilityHidden(true)
    }
    private var fallback: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.1))
            if let name = agent?.name { Text(String(name.prefix(1))).font(.headline).foregroundStyle(.primary) }
            else { Image(systemName: "sparkles").foregroundStyle(Color.accentColor) }
        }
    }
}

struct iOSAgentPicker: View {
    @ObservedObject var viewModel: iOSEveChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    var body: some View {
        NavigationStack {
            List {
                Button { select(nil) } label: { row(nil) }.buttonStyle(.plain)
                if viewModel.isLoadingAgents { ProgressView("Loading agents…") }
                if let error = viewModel.agentLoadError {
                    Section { Text(error).foregroundStyle(.secondary); Button("Try again") { Task { await viewModel.loadAgents() } } }
                }
                ForEach([iOSChatAgent.Kind.teammate, .persona], id: \.rawValue) { kind in
                    let matches = viewModel.agents.filter { $0.kind == kind && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.detail.localizedCaseInsensitiveContains(search)) }
                    if !matches.isEmpty {
                        Section(kind == .teammate ? "Your agents" : "Personas") {
                            ForEach(matches) { agent in Button { select(agent) } label: { row(agent) }.buttonStyle(.plain) }
                        }
                    }
                }
                if !viewModel.isLoadingAgents && viewModel.agents.isEmpty && viewModel.agentLoadError == nil {
                    Text("Agents you add to this workspace appear here.").foregroundStyle(.secondary)
                }
            }
            .searchable(text: $search, prompt: "Find an agent")
            .navigationTitle("Choose an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await viewModel.loadAgents() }
        }
    }
    private func select(_ agent: iOSChatAgent?) {
        dismiss()
        Task { await viewModel.selectAgent(agent) }
    }
    private func row(_ agent: iOSChatAgent?) -> some View {
        HStack(spacing: 12) {
            iOSAgentThumbnail(agent: agent).frame(width: 48, height: 48)
            VStack(alignment: .leading, spacing: 3) {
                Text(agent?.name ?? "Native Intelligence").font(.body.weight(.medium)).foregroundStyle(.primary)
                Text(agent?.detail ?? "Your everyday assistant").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            if agent?.id == viewModel.selectedAgent?.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
        .padding(.vertical, 4)
    }
}

struct iOSAgentProfile: View {
    let agent: iOSChatAgent
    var working: Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let character = agent.character {
                    iOSAgentAvatar(character: character, working: working).frame(width: 180, height: 180)
                } else { iOSAgentThumbnail(agent: agent).frame(width: 100, height: 100).padding(40) }
                Text(agent.name).font(.system(size: 30, design: .serif))
                Text(agent.detail).font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Label(working ? "Working on your reply" : "Ready to help", systemImage: working ? "ellipsis" : "bubble.left")
                    .font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
                Spacer(minLength: 0)
            }
            .padding(24)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct iOSEveInputCard: View {
    let request: EveInputRequest
    let busy: Bool
    let onAnswer: (String?, String?) -> Void
    @State private var answer = ""
    @State private var questionAnswers: [Int: String] = [:]

    private var responseText: String {
        if request.questions.isEmpty { return answer.trimmingCharacters(in: .whitespacesAndNewlines) }
        return request.questions.enumerated().compactMap { index, question in
            guard let answer = questionAnswers[index]?.trimmingCharacters(in: .whitespacesAndNewlines), !answer.isEmpty else { return nil }
            return "\(question["question"] as? String ?? "Question"): \(answer)"
        }.joined(separator: "\n")
    }
    private var hasAnswers: Bool {
        request.questions.isEmpty ? !responseText.isEmpty : request.questions.indices.allSatisfy {
            !(questionAnswers[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
    private func isDecline(_ option: EveInputRequest.Option) -> Bool {
        option.isDestructive || ["cancel", "deny"].contains(option.id)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(request.questions.isEmpty ? request.prompt : "A question for you").font(.headline)
            ForEach(Array(request.questions.enumerated()), id: \.offset) { index, question in
                if let prompt = question["question"] as? String { Text(prompt).font(.subheadline.weight(.medium)) }
                if let options = question["options"] as? [[String: Any]] {
                    ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                        if let label = option["label"] as? String {
                            Button { questionAnswers[index] = label } label: {
                                HStack {
                                    Text(label).multilineTextAlignment(.leading)
                                    Spacer()
                                    if questionAnswers[index] == label { Image(systemName: "checkmark") }
                                }
                            }
                            .buttonStyle(.bordered)
                            .disabled(busy)
                        }
                    }
                }
                TextField("Your answer", text: Binding(get: { questionAnswers[index] ?? "" }, set: { questionAnswers[index] = $0 }), axis: .vertical)
                    .textFieldStyle(.roundedBorder).disabled(busy)
            }
            if request.allowsText && request.questions.isEmpty {
                TextField("Your answer", text: $answer, axis: .vertical).textFieldStyle(.roundedBorder).disabled(busy)
            }
            ForEach(request.options) { option in
                Button(role: isDecline(option) ? .destructive : nil) {
                    onAnswer(option.id, responseText.isEmpty ? nil : responseText)
                } label: {
                    Text(!request.questions.isEmpty && !isDecline(option) ? "Send answer" : option.label).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(busy || (!request.questions.isEmpty && !isDecline(option) && !hasAnswers))
            }
            if request.options.isEmpty && request.allowsText {
                Button("Send answer") { onAnswer(nil, responseText) }.disabled(busy || !hasAnswers)
            }
        }
        .padding(16).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}
