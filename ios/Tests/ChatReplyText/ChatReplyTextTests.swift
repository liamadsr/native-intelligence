import Foundation

@main struct ChatReplyTextTests {
    static func expect(_ input: String, _ wanted: String, _ message: String) {
        let got = ChatReplyText.strippingComments(input)
        if got != wanted { fatalError("\(message)\n  input:  \(input.debugDescription)\n  wanted: \(wanted.debugDescription)\n  got:    \(got.debugDescription)") }
    }

    static func main() {
        // The same cases as web/src/lib/chat/__tests__/strip-comments.test.ts.
        expect("Moved it to Friday.\n\n<!-- card:4 -->", "Moved it to Friday.\n\n", "a trailing comment on its own line goes")
        expect("Moved it to Friday. <!-- card:4 -->", "Moved it to Friday.", "a trailing comment after the last word goes")
        expect("Your board <!-- card:1 --> is ready.", "Your board is ready.", "a comment between two words leaves one space")
        expect("Your board<!-- card:1 -->is ready.", "Your board is ready.", "a comment touching two words leaves one space")
        expect("a <!-- x --><!-- y --> b", "a b", "a run of comments between two words leaves one space")
        expect("a <!-- x --> <!-- y --> b", "a b", "a spaced run of comments leaves one space")
        expect("Close it?\n<!-- proposal:3f2a-91 -->\nSay yes.", "Close it?\nSay yes.", "a proposal marker goes")
        expect("Close it?\n<!--\nproposal:3f2a-91\n-->\nSay yes.", "Close it?\nSay yes.", "a wrapped proposal marker goes")
        let code = "See:\n```html\n<!-- header -->\n<p>hi</p>\n```\nand `<!-- x -->`."
        expect(code, code, "comments inside code stay")
        expect("Half:\n```html\n<!-- header -->", "Half:\n```html\n<!-- header -->", "a fence still streaming keeps its comments")
        expect("Run <!-- card:2 --> `npm test` now.", "Run `npm test` now.", "a word and the next code span keep their space")
        expect("Done. <!-- see `x` -->", "Done.", "a comment holding a code span goes whole")
        let literal = "Type <!-- to start a comment.\nThe arrow --> closes it."
        expect(literal, literal, "a literal <!-- never eats the prose after it")
        expect("Price: $5 <!-- card:1 --> and \\1 `$0`", "Price: $5 and \\1 `$0`", "dollar signs and backslashes survive")
        expect("Plain `code` and ```\nfence\n```", "Plain `code` and ```\nfence\n```", "text without a comment is unchanged")
        expect("Café ☕️ <!-- card:4 --> done 👍🏽", "Café ☕️ done 👍🏽", "emoji and accents keep their place")

        // Long runs of comments, and of openers that never close, stay linear.
        let pathological = Date()
        _ = ChatReplyText.strippingComments("word " + String(repeating: "<!-- a --> ", count: 500) + "\n")
        _ = ChatReplyText.strippingComments("word " + String(repeating: "<!-- ", count: 500))
        if Date().timeIntervalSince(pathological) > 0.2 { fatalError("long runs of comments took over 200 ms") }

        // Cost per render, so per streamed token: a long reply with a comment, many times.
        let reply = String(repeating: "A line of a long reply with `code` and **bold** words.\n", count: 80) + "<!-- card:4 -->"
        let runs = 500
        let start = Date()
        for _ in 0..<runs { _ = ChatReplyText.strippingComments(reply) }
        let perRun = Date().timeIntervalSince(start) / Double(runs) * 1000
        if perRun > 5 { fatalError("strippingComments took \(perRun) ms on a \(reply.utf16.count)-character reply") }
        let plain = String(repeating: "A line of a long reply with `code` and **bold** words.\n", count: 80)
        let plainStart = Date()
        for _ in 0..<runs { _ = ChatReplyText.strippingComments(plain) }
        let plainRun = Date().timeIntervalSince(plainStart) / Double(runs) * 1000
        print(String(format: "PASS: comment stripping (%.3f ms per render on a %d-character reply with a comment, %.4f ms without)", perRun, reply.utf16.count, plainRun))
    }
}
