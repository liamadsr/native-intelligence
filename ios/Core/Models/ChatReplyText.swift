//
//  ChatReplyText.swift
//  dial8
//
//  An assistant reply, made fit for the chat bubble.
//

import Foundation

/// HTML comments out of an assistant reply before the chat renders it. The chat
/// agent marks a suggestion with `<!-- proposal:ID -->` (the iPhone has no
/// suggestion cards, so it drops those too) and sometimes copies that shape for
/// things that aren't proposals (`<!-- card:4 -->`). MarkdownUI would print
/// either as text.
///
/// The same rules as the web's `stripHtmlComments`
/// (web/src/lib/chat/strip-comments.ts): code is left as written (fenced blocks
/// and `code spans` keep their comments), and a comment must open and close on
/// one line (a proposal marker may wrap), so a literal `<!--` in prose never
/// eats the text after it.
///
/// It runs on every render, so on every streamed token: a reply without `<!--`
/// is returned as it is after one byte scan (a few microseconds on 4 KB), and
/// one with a comment takes five linear regex passes (about 0.3 ms on 4 KB).
enum ChatReplyText {
    /// Fenced blocks (to their closing fence, or the end of a reply still
    /// streaming) and code spans.
    private static let code = try? NSRegularExpression(pattern: "```[\\s\\S]*?(?:```|\\z)|`[^`\\n]*`")
    /// Stands in for a piece of code while the comments go; NUL never appears in a reply.
    private static let codeSlot = try? NSRegularExpression(pattern: "\\x00(\\d+)\\x00")
    private static let rules: [(NSRegularExpression?, String)] = [
        // Comments between two words leave one space, so the words don't run
        // together. A body can't hold `-->`, so a failed match can't re-split
        // the run: linear, not exponential.
        (try? NSRegularExpression(pattern: "(?<=\\S)[ \\t]*(?:<!--(?:(?!-->)[^\\n])*-->[ \\t]*)+(?=\\S)"), " "),
        (try? NSRegularExpression(pattern: "[ \\t]*<!--\\s*proposal:[a-zA-Z0-9-]+\\s*-->[ \\t]*\\n?"), ""),
        (try? NSRegularExpression(pattern: "[ \\t]*<!--[^\\n]*?-->[ \\t]*\\n?"), ""),
    ]

    static func strippingComments(_ text: String) -> String {
        guard hasCommentOpen(text), let code, let codeSlot else { return text }
        let out = NSMutableString(string: text)

        // Set code aside first, so a comment just before a code span still
        // leaves a space between the word and the span. Last match first, so
        // the earlier ranges stay put.
        let codeMatches = code.matches(in: text, range: NSRange(location: 0, length: out.length))
        let pieces = codeMatches.map { out.substring(with: $0.range) }
        for (i, match) in codeMatches.enumerated().reversed() {
            out.replaceCharacters(in: match.range, with: "\u{0}\(i)\u{0}")
        }

        for (rule, template) in rules {
            rule?.replaceMatches(in: out, range: NSRange(location: 0, length: out.length), withTemplate: template)
        }

        // Put the code back (a comment that held a code span took its slot with it).
        for match in codeSlot.matches(in: out as String, range: NSRange(location: 0, length: out.length)).reversed() {
            guard let i = Int(out.substring(with: match.range(at: 1))), pieces.indices.contains(i) else { continue }
            out.replaceCharacters(in: match.range, with: pieces[i])
        }
        return out as String
    }

    /// Whether the text has a `<!--` at all. A byte scan: about 30 times
    /// quicker than `String.contains`, and most replies have no comment.
    private static func hasCommentOpen(_ text: String) -> Bool {
        text.utf8.withContiguousStorageIfAvailable { bytes in
            memmem(bytes.baseAddress, bytes.count, "<!--", 4) != nil
        } ?? text.contains("<!--")
    }
}
