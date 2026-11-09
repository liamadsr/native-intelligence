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
/// and `code spans` keep their comments); a comment must open and close on one
/// line (a proposal marker may wrap), so a literal `<!--` in prose never eats
/// the text after it; line breaks stay where they were, unless a line held
/// nothing but comments.
///
/// It runs on every render, so on every streamed token, on the main thread. A
/// reply without `<!--` is returned as it is after one byte scan (a few
/// microseconds on 4 KB). One with a comment takes a few regex passes, each
/// linear: a comment's body can't hold `-->` or another `<!--`, and each run of
/// spaces is matched only from its start.
enum ChatReplyText {
    private static let comment = "<!--(?:(?!-->|<!--)[^\\n])*-->"
    /// Fenced blocks (to their closing fence, or the end of a reply still
    /// streaming) and code spans.
    private static let code = try? NSRegularExpression(pattern: "```[\\s\\S]*?(?:```|\\z)|`[^`\\n]*`")
    /// Stands in for a piece of code while the comments go; NUL never appears in a reply.
    private static let codeSlot = try? NSRegularExpression(pattern: "\\x00(\\d+)\\x00")
    private static let rules: [(NSRegularExpression?, String)] = [
        // A proposal marker that wraps, folded onto one line for the rules below.
        (try? NSRegularExpression(pattern: "<!--\\s*(proposal:[a-zA-Z0-9-]+)\\s*-->"), "<!-- $1 -->"),
        // A line of nothing but comments goes, with its line break.
        (try? NSRegularExpression(pattern: "^[ \\t]*(?:\(comment)[ \\t]*)+(?:\\n|$)", options: [.anchorsMatchLines]), ""),
        // Comments between two words leave one space, so the words don't run
        // together (none before punctuation).
        (try? NSRegularExpression(pattern: "(?<=\\S)[ \\t]*(?:\(comment)[ \\t]*)+(?=[^\\s.,;:!?)\\]}])"), " "),
        // Any other comment goes with the spaces around it; the line break after it stays.
        (try? NSRegularExpression(pattern: "(?<![ \\t])[ \\t]*(?:\(comment)[ \\t]*)+"), ""),
    ]

    /// - Parameter streaming: the reply is still arriving, so a comment whose
    ///   `-->` hasn't come yet (`… <!-- card:4`) is hidden too. A finished reply
    ///   keeps an unclosed `<!--`: there it's prose, not a comment.
    static func strippingComments(_ text: String, streaming: Bool = false) -> String {
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
        if streaming { dropUnclosedTail(out) }

        // Put the code back (a comment that held a code span took its slot with it).
        for match in codeSlot.matches(in: out as String, range: NSRange(location: 0, length: out.length)).reversed() {
            guard let i = Int(out.substring(with: match.range(at: 1))), pieces.indices.contains(i) else { continue }
            out.replaceCharacters(in: match.range, with: pieces[i])
        }
        return out as String
    }

    /// A comment still arriving on the last line: from its `<!--` (and the
    /// spaces before it) to the end, when no `-->` follows.
    private static func dropUnclosedTail(_ out: NSMutableString) {
        let newline = out.range(of: "\n", options: .backwards)
        let lineStart = newline.location == NSNotFound ? 0 : newline.location + 1
        let open = out.range(of: "<!--", options: [], range: NSRange(location: lineStart, length: out.length - lineStart))
        guard open.location != NSNotFound else { return }
        let afterOpen = open.location + open.length
        guard out.range(of: "-->", options: [], range: NSRange(location: afterOpen, length: out.length - afterOpen)).location == NSNotFound else { return }
        var cut = open.location
        while cut > lineStart, [0x20, 0x09].contains(out.character(at: cut - 1)) { cut -= 1 }
        out.deleteCharacters(in: NSRange(location: cut, length: out.length - cut))
    }

    /// Whether the text has a `<!--` at all. A byte scan: about 30 times
    /// quicker than `String.contains`, and most replies have no comment.
    private static func hasCommentOpen(_ text: String) -> Bool {
        text.utf8.withContiguousStorageIfAvailable { bytes in
            memmem(bytes.baseAddress, bytes.count, "<!--", 4) != nil
        } ?? text.contains("<!--")
    }
}
