import SwiftUI
import Auth

struct UserAvatarView: View {
    let size: CGFloat
    @StateObject private var supabaseManager = SupabaseManager.shared

    var body: some View {
        if supabaseManager.isAuthenticated {
            if let avatarUrl = avatarURL {
                AsyncImage(url: avatarUrl) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: size, height: size)
                        .clipShape(Circle())
                } placeholder: {
                    fallbackIcon
                }
            } else {
                fallbackIcon
            }
        } else {
            Image(systemName: "person.crop.circle")
                .font(.system(size: size * 0.82))
                .foregroundStyle(.secondary)
        }
    }

    /// Monochrome on purpose — the tinted accent version read as a stray colour
    /// chip in the otherwise neutral iOS chrome.
    private var fallbackIcon: some View {
        Image(systemName: "person.crop.circle.fill")
            .font(.system(size: size * 0.82))
            .foregroundStyle(.secondary)
    }

    private var avatarURL: URL? {
        guard let user = supabaseManager.currentUser else { return nil }
        let meta = user.userMetadata
        if let value = meta["avatar_url"] ?? meta["picture"] ?? meta["avatarUrl"],
           case let .string(urlString) = value {
            return URL(string: urlString)
        }
        return nil
    }
}
