//! What an agent wrote that GitHub would act on, made inert before it is
//! published under the person's name: a pull request's title and
//! description ([`super::prompts::PushAsk::made_inert`], every push, our own
//! agent's and a coding agent's alike), and a commit's message
//! ([`super::git::commit_subject`]).
//!
//! Each is made inert by breaking the TOKEN itself, so it is inert in any
//! context (a paragraph, an HTML block, a commit message), never by wrapping
//! it (a code span is literal text inside an HTML block):
//! - every mention (`@user`, `@org/team`) gets a zero-width space after its
//!   at sign, whichever spelling renders as one: `@`, `\@`, `&#64;`,
//!   `&#x40;` (any case, any leading zeros), `&commat;`;
//! - a closing reference to ANOTHER repository has its reference broken:
//!   `fixes o/r#3` → `fixes o/r issue 3`, a full issue or pull request URL
//!   likewise, the `#` in any spelling (`#`, `\#`, `&#35;`, `&#x23;`,
//!   `&num;`);
//! - HTML comments (`<!-- … -->`) are removed: hidden text has no honest use
//!   in a generated description;
//! - a closing reference to the SAME repository (`fixes #12`, any spelling)
//!   stays in a description, where the prompt lists it ("Closes when
//!   merged: #12"); in a commit message (never shown to the person) its
//!   reference is broken too, `fixes #12` → `fixes issue 12`.
//!
//! Text in REAL code is left as it is, by CommonMark's rules, and where this
//! scanner can't be sure, the text is treated as PROSE (a code sample with a
//! broken mention is cosmetic; a live mention or closer is the harm):
//! - a fence opens on a line indented at most 3 spaces with 3 or more `` ` ``
//!   or `~` (a backtick fence's info string holds no backtick), and closes on
//!   a line of the same character, at least as many, indented at most 3
//!   spaces; an unclosed fence runs to the end, as on GitHub. Anything else
//!   (an indented block included) is prose;
//! - a code span opened by N backticks closes at a run of exactly N, within
//!   its paragraph (never across a blank line or a line that starts another
//!   block); a run with no closer is escaped (`` \` ``), so it pairs with
//!   nothing;
//! - an HTML block (a line starting with a tag, a comment, `<?`, `<!`)
//!   runs to its end (a blank line, or `</pre>` and the like): nothing in it
//!   is code, and backslash escapes are left alone;
//! - a mention starts at the start of the text or after any character that
//!   isn't a letter, digit or underscore (those make an email-like word).
//!
//! Applying it twice changes nothing more.

/// GitHub's closing keywords.
const KEYWORDS: &[&str] = &["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

/// What [`make_inert`] did, and the text it made.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Inert {
    pub text: String,
    /// Same-repository references a closing keyword names (`#12`), in order.
    pub closes: Vec<String>,
    pub mentions: usize,
    pub foreign_refs: usize,
    pub comments: usize,
    /// The prose holds an HTML tag (GitHub may collapse or drop it).
    pub html: bool,
}

impl Inert {
    /// Anything was changed so it can't act.
    pub fn changed(&self) -> bool {
        self.mentions + self.foreign_refs + self.comments > 0
    }
}

/// Where the text goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A pull request's title or description: same-repository closing
    /// references stay (and are listed).
    Description,
    /// A commit message: every closing reference has its reference broken.
    Commit,
}

/// A fence's opening line: its character and length (CommonMark).
fn fence_open(line: &str) -> Option<(u8, usize)> {
    let body = line.trim_end_matches(['\n', '\r']);
    let indent = body.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &body[indent..];
    let c = *rest.as_bytes().first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = rest.bytes().take_while(|b| *b == c).count();
    if n < 3 || (c == b'`' && rest[n..].contains('`')) {
        return None;
    }
    Some((c, n))
}

/// A line that closes the fence `(c, n)`.
fn fence_close(line: &str, c: u8, n: usize) -> bool {
    let body = line.trim_end_matches(['\n', '\r']);
    let indent = body.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return false;
    }
    let rest = &body[indent..];
    let run = rest.bytes().take_while(|b| *b == c).count();
    run >= n && rest[run..].bytes().all(|b| b == b' ' || b == b'\t')
}

/// An HTML block's opening line (CommonMark's kinds, treated broadly:
/// unsure, it is HTML, where nothing is code): what ends it, `None` for a
/// blank line, and the opener's length.
fn html_open(line: &str) -> Option<(Option<&'static str>, usize)> {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let t = &line[indent..];
    let lower = t.to_ascii_lowercase();
    for name in ["script", "pre", "style", "textarea"] {
        let open = format!("<{name}");
        if lower.starts_with(&open) && lower[open.len()..].chars().next().is_none_or(|c| c.is_whitespace() || c == '>') {
            return Some((Some(match name {
                "script" => "</script",
                "pre" => "</pre",
                "style" => "</style",
                _ => "</textarea",
            }), indent + open.len()));
        }
    }
    let ends: [(&str, &'static str); 4] = [("<!--", "-->"), ("<![cdata[", "]]>"), ("<?", "?>"), ("<!", ">")];
    for (open, end) in ends {
        if lower.starts_with(open) {
            return Some((Some(end), indent + open.len()));
        }
    }
    let rest = t.strip_prefix('<')?;
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    rest.chars().next().filter(char::is_ascii_alphabetic).map(|_| (None, indent + 1))
}

/// `text` made inert ([module notes](self)); `repo` is the pull request's
/// repository as `owner/name` (any case), when known.
pub fn make_inert(text: &str, repo: Option<&str>, kind: Kind) -> Inert {
    enum Block {
        Fence(u8, usize),
        Html(Option<&'static str>),
    }
    let repo = repo.map(str::to_ascii_lowercase);
    let mut out = Inert::default();
    let mut prose = String::new();
    let mut html = String::new();
    let mut block: Option<Block> = None;
    let r = repo.as_deref();
    for line in text.split_inclusive('\n') {
        match &block {
            Some(Block::Fence(c, n)) => {
                out.text.push_str(line);
                if fence_close(line, *c, *n) {
                    block = None;
                }
            }
            // A blank line ends it, and is the prose's.
            Some(Block::Html(None)) if line.trim().is_empty() => {
                flush(&mut html, &mut out, r, kind, false);
                block = None;
                prose.push_str(line);
            }
            Some(Block::Html(end)) => {
                let ended = end.is_some_and(|e| line.to_ascii_lowercase().contains(e));
                html.push_str(line);
                if ended {
                    flush(&mut html, &mut out, r, kind, false);
                    block = None;
                }
            }
            None => {
                if let Some((c, n)) = fence_open(line) {
                    flush(&mut prose, &mut out, r, kind, true);
                    out.text.push_str(line);
                    block = Some(Block::Fence(c, n));
                } else if let Some((end, opener)) = html_open(line) {
                    flush(&mut prose, &mut out, r, kind, true);
                    html.push_str(line);
                    let ended = end.is_some_and(|e| line[opener..].to_ascii_lowercase().contains(e));
                    if ended {
                        flush(&mut html, &mut out, r, kind, false);
                    } else {
                        block = Some(Block::Html(end));
                    }
                } else {
                    prose.push_str(line);
                }
            }
        }
    }
    flush(&mut html, &mut out, r, kind, false);
    flush(&mut prose, &mut out, r, kind, true);
    out
}

/// `spans`: markdown, where code spans are code; off in an HTML block,
/// where nothing is.
fn flush(prose: &mut String, out: &mut Inert, repo: Option<&str>, kind: Kind, spans: bool) {
    if !prose.is_empty() {
        let bare = without_comments(prose, out);
        let made = inert_prose(&bare, repo, kind, out, spans);
        out.text.push_str(&made);
        prose.clear();
    }
}

/// Every `<!-- … -->` gone (one never closed: to the end), again until
/// none is left (removing one may join another).
fn without_comments(text: &str, out: &mut Inert) -> String {
    let mut text = text.to_string();
    while let Some(at) = text.find("<!--") {
        let end = text[at + 4..].find("-->").map_or(text.len(), |e| at + 4 + e + 3);
        text.replace_range(at..end, "");
        out.comments += 1;
    }
    text
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The character `code` spelled at the start of `s` as an HTML entity:
/// `&#64;`, `&#x40;` (any case, any leading zeros, with or without the
/// semicolon: an HTML parser takes it without, as it takes every digit that
/// follows) or `&name;`. Its length.
fn entity(s: &str, code: u32, names: &[&str]) -> Option<usize> {
    let t = s.strip_prefix("&")?;
    if let Some(num) = t.strip_prefix('#') {
        let (digits, radix, skip) = match num.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16, 2),
            None => (num, 10, 1),
        };
        let n = digits.bytes().take_while(|b| (*b as char).is_digit(radix)).count();
        if n == 0 || n > 16 {
            return None;
        }
        let semi = usize::from(digits[n..].starts_with(';'));
        let value = u64::from_str_radix(&digits[..n], radix).ok()?;
        return (value == u64::from(code)).then_some(1 + skip + n + semi);
    }
    names
        .iter()
        .find(|name| t.starts_with(*name) && t[name.len()..].starts_with(';'))
        .map(|name| 1 + name.len() + 1)
}

/// An at sign at the start of `s`, in a spelling that renders as one:
/// `@`, `\@`, `&#64;`, `&#x40;`, `&commat;`. Its length.
fn at_sign(s: &str) -> Option<usize> {
    if s.starts_with('@') {
        return Some(1);
    }
    if s.starts_with("\\@") {
        return Some(2);
    }
    entity(s, 64, &["commat"])
}

/// A `#` at the start of `s`, in a spelling that renders as one: `#`,
/// `\#`, `&#35;`, `&#x23;`, `&num;`. Its length.
fn hash(s: &str) -> Option<usize> {
    if s.starts_with('#') {
        return Some(1);
    }
    if s.starts_with("\\#") {
        return Some(2);
    }
    entity(s, 35, &["num"])
}

/// A GitHub user (or org) name at the start of `s`: letters, digits and
/// single hyphens, 1 to 39, not starting with a hyphen. Its length.
fn username(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.first().is_none_or(|c| !c.is_ascii_alphanumeric()) {
        return None;
    }
    let n = b.iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'-').count();
    (n <= 39).then_some(n)
}

/// A mention at the start of `s` (just after its at sign): `user` or
/// `org/team`. Its length. One already broken (a zero-width space after
/// the at sign) isn't one.
fn mention(s: &str) -> Option<usize> {
    let user = username(s)?;
    let rest = &s[user..];
    if let Some(team) = rest.strip_prefix('/') {
        let t = team.bytes().take_while(|c| c.is_ascii_alphanumeric() || b"-_.".contains(c)).count();
        if t > 0 {
            return Some(user + 1 + t);
        }
    }
    Some(user)
}
/// A reference at the start of `s`: `#12`, `owner/repo#12` (the `#` in
/// any spelling, [`hash`]), or a GitHub issue / pull request URL. (its
/// length, `Some(owner/repo)` or `None` for this repository, the number).
fn reference(s: &str) -> Option<(usize, Option<String>, String)> {
    let digits = |t: &str| t.bytes().take_while(u8::is_ascii_digit).count();
    if let Some(h) = hash(s) {
        let n = digits(&s[h..]);
        return (n > 0).then(|| (h + n, None, s[h..h + n].to_string()));
    }
    for scheme in ["https://github.com/", "http://github.com/", "https://www.github.com/"] {
        if let Some(t) = s.get(..scheme.len()).filter(|p| p.eq_ignore_ascii_case(scheme)).map(|_| &s[scheme.len()..]) {
            let owner = username(t)?;
            let t2 = t[owner..].strip_prefix('/')?;
            let name = t2.bytes().take_while(|c| c.is_ascii_alphanumeric() || b"-_.".contains(c)).count();
            let t3 = &t2[name..];
            let t4 = t3.strip_prefix("/issues/").or_else(|| t3.strip_prefix("/pull/"))?;
            let n = digits(t4);
            if n == 0 || name == 0 {
                return None;
            }
            let len = scheme.len() + owner + 1 + name + (t3.len() - t4.len()) + n;
            return Some((len, Some(format!("{}/{}", &t[..owner], &t2[..name])), t4[..n].to_string()));
        }
    }
    let owner = username(s)?;
    let t = s[owner..].strip_prefix('/')?;
    let name = t.bytes().take_while(|c| c.is_ascii_alphanumeric() || b"-_.".contains(c)).count();
    let h = hash(&t[name..])?;
    let t2 = &t[name + h..];
    let n = digits(t2);
    (name > 0 && n > 0).then(|| (owner + 1 + name + h + n, Some(format!("{}/{}", &s[..owner], &t[..name])), t2[..n].to_string()))
}

/// A closing keyword at the start of `s` and what separates it from its
/// reference (an optional colon, then spaces): their length.
fn keyword(s: &str) -> Option<usize> {
    let word = s.bytes().take_while(u8::is_ascii_alphabetic).count();
    if !KEYWORDS.iter().any(|k| s[..word].eq_ignore_ascii_case(k)) {
        return None;
    }
    let mut i = word;
    if s[i..].starts_with(':') {
        i += 1;
    }
    let spaces = s[i..].bytes().take_while(|c| *c == b' ' || *c == b'\t').count();
    (spaces > 0 || i > word).then_some(i + spaces)
}

/// A line that starts a block of its own (or is blank): a code span never
/// runs into it.
fn starts_block(line: &str) -> bool {
    // Indented 4 or more (or by a tab): maybe an indented code block, so
    // a span never runs into it (unsure: prose).
    if line.starts_with("    ") || line.starts_with('\t') {
        return true;
    }
    let t = line.trim_start_matches([' ', '\t']);
    let Some(first) = t.trim_end().chars().next() else {
        return true;
    };
    if matches!(first, '#' | '>' | '-' | '*' | '+' | '<' | '|' | '=') {
        return true;
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && matches!(t.as_bytes().get(digits), Some(b'.') | Some(b')'))
}

/// Where a code span may close, for the prose `text`: for each line, the
/// end of its paragraph ([`starts_block`]); and each length's backtick runs.
struct Spans {
    line_starts: Vec<usize>,
    para_end: Vec<usize>,
    runs: std::collections::HashMap<usize, Vec<usize>>,
}

impl Spans {
    fn new(text: &str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(text.match_indices('\n').map(|(i, _)| i + 1).filter(|i| *i < text.len()));
        let mut para_end = vec![text.len(); line_starts.len()];
        for l in (0..line_starts.len()).rev() {
            let next = line_starts.get(l + 1).copied();
            para_end[l] = match next {
                None => text.len(),
                Some(n) => {
                    let line = text[n..].split('\n').next().unwrap_or_default();
                    if starts_block(line) {
                        n
                    } else {
                        para_end[l + 1]
                    }
                }
            };
        }
        let mut runs: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
        let b = text.as_bytes();
        let mut j = 0;
        while j < b.len() {
            if b[j] == b'`' {
                let n = b[j..].iter().take_while(|x| **x == b'`').count();
                runs.entry(n).or_default().push(j);
                j += n;
            } else {
                j += 1;
            }
        }
        Spans { line_starts, para_end, runs }
    }

    /// A span opened by `ticks` backticks at `at`: its whole length.
    fn close(&self, at: usize, ticks: usize) -> Option<usize> {
        let line = self.line_starts.partition_point(|s| *s <= at) - 1;
        let limit = self.para_end[line];
        let runs = self.runs.get(&ticks)?;
        let next = runs[runs.partition_point(|r| *r < at + ticks)..].first().copied()?;
        (next + ticks <= limit).then(|| next + ticks - at)
    }
}

/// An HTML tag at the start of `s`: `<name`, `</name`, `<!`.
fn html_tag(s: &str) -> bool {
    let t = s.strip_prefix('<').unwrap_or_default();
    let t = t.strip_prefix('/').unwrap_or(t);
    t.starts_with('!') || t.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

/// Breaks a mention's token: after its at sign, whatever the context.
const BREAK: char = '\u{200B}';

fn inert_prose(text: &str, repo: Option<&str>, kind: Kind, out: &mut Inert, spans_on: bool) -> String {
    let spans = Spans::new(text);
    let mut res = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().unwrap_or_default();
        let boundary = prev.is_none_or(|p| !is_word(p));
        // A mention, in any spelling of its at sign: broken after it.
        if boundary {
            if let Some(at) = at_sign(rest) {
                if let Some(len) = mention(&rest[at..]) {
                    res.push_str(&rest[..at]);
                    res.push(BREAK);
                    res.push_str(&rest[at..at + len]);
                    out.mentions += 1;
                    prev = rest[..at + len].chars().last();
                    i += at + len;
                    continue;
                }
            }
        }
        if spans_on {
            // A backslash escape: as it is (an escaped backtick opens nothing).
            if c == '\\' {
                if let Some(n) = rest[1..].chars().next().filter(char::is_ascii_punctuation) {
                    res.push('\\');
                    res.push(n);
                    prev = Some(n);
                    i += 1 + n.len_utf8();
                    continue;
                }
            }
            if c == '`' {
                let ticks = rest.bytes().take_while(|b| *b == b'`').count();
                let len = match spans.close(i, ticks) {
                    // An existing code span: as it is.
                    Some(len) => {
                        res.push_str(&rest[..len]);
                        len
                    }
                    // A run with no closer: escaped, so it pairs with nothing.
                    None => {
                        (0..ticks).for_each(|_| res.push_str("\\`"));
                        ticks
                    }
                };
                i += len;
                prev = Some('`');
                continue;
            }
        }
        if c == '<' && html_tag(rest) {
            out.html = true;
        }
        if boundary && c.is_ascii_alphabetic() {
            if let Some(kw) = keyword(rest) {
                if let Some((len, owner_repo, number)) = reference(&rest[kw..]) {
                    let ends_clean = rest[kw + len..].chars().next().is_none_or(|n| !is_word(n));
                    if ends_clean {
                        let same = owner_repo.as_deref().is_none_or(|r| repo.is_some_and(|me| r.eq_ignore_ascii_case(me)));
                        res.push_str(&rest[..kw]);
                        if same && kind == Kind::Description {
                            // Listed in the prompt, published as written.
                            res.push_str(&rest[kw..kw + len]);
                            out.closes.push(format!("#{number}"));
                        } else {
                            // The reference itself broken: nothing links or closes.
                            match owner_repo {
                                Some(o) => res.push_str(&format!("{o} issue {number}")),
                                None => res.push_str(&format!("issue {number}")),
                            }
                            if !same {
                                out.foreign_refs += 1;
                            }
                        }
                        prev = res.chars().last();
                        i += kw + len;
                        continue;
                    }
                }
            }
        }
        res.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Inert {
        make_inert(s, Some("Acme/Site"), Kind::Description)
    }

    /// An expected text: `¦` is where the zero-width space goes.
    fn z(s: &str) -> String {
        s.replace('¦', "\u{200B}")
    }

    #[test]
    fn mentions_are_broken_after_their_at_sign_and_emails_stay() {
        assert_eq!(d("thanks @alice and @org/team-x!").text, z("thanks @¦alice and @¦org/team-x!"));
        assert_eq!(d("@bob").mentions, 1);
        assert_eq!(d("mail me: a.b@example.com").text, "mail me: a.b@example.com");
        assert_eq!(d("x@y").text, "x@y");
        assert_eq!(d("(@carol)").text, z("(@¦carol)"));
        assert_eq!(d("@-nope").text, "@-nope", "not a user name");
    }

    #[test]
    fn every_spelling_of_the_at_sign_is_broken_in_a_paragraph_and_in_html() {
        for (from, to) in [
            ("@octocat", "@¦octocat"),
            ("\\@octocat", "\\@¦octocat"),
            ("&#64;octocat", "&#64;¦octocat"),
            ("&#0064;octocat", "&#0064;¦octocat"),
            ("&#x40;octocat", "&#x40;¦octocat"),
            ("&#X040;octocat", "&#X040;¦octocat"),
            ("&#x0040;octocat", "&#x0040;¦octocat"),
            ("&commat;octocat", "&commat;¦octocat"),
            ("&#64octocat", "&#64¦octocat"),
            ("&#x40octocat", "&#x40¦octocat"),
            ("&#X0040octocat", "&#X0040¦octocat"),
            ("&#64;org/team", "&#64;¦org/team"),
        ] {
            assert_eq!(d(&format!("hi {from} there")).text, z(&format!("hi {to} there")), "{from}");
            let html = format!("<div>\n{from} and `{from}`\n</div>");
            let want = z(&format!("<div>\n{to} and `{to}`\n</div>"));
            assert_eq!(d(&html).text, want, "in an HTML block, a backtick is literal: {from}");
        }
        // Not an at sign: every digit belongs to the number, as a parser reads it.
        for word in ["a&#64;octocat", "me\\@example", "x&commat;y", "&#65;octocat", "&#6412", "&#x40abc", "&commatoctocat"] {
            assert_eq!(d(word).text, word, "{word}");
        }
    }

    #[test]
    fn closing_references_to_another_repository_are_broken() {
        let i = d("Fixes other/repo#3 and closes: https://github.com/other/repo/issues/9.");
        assert_eq!(i.text, "Fixes other/repo issue 3 and closes: other/repo issue 9.");
        assert_eq!(i.foreign_refs, 2);
        assert!(i.closes.is_empty());
        // Without its semicolon, `&#35` takes the digits after it into its
        // number (U+0DB8): no `#`, no reference.
        assert_eq!(d("fixes other/repo&#353").text, "fixes other/repo&#353");
        assert_eq!(hash("&#35"), Some(4));
        for spelled in ["other/repo\\#3", "other/repo&#35;3", "other/repo&#x23;3", "other/repo&num;3"] {
            assert_eq!(d(&format!("fixes {spelled}")).text, "fixes other/repo issue 3", "{spelled}");
            assert_eq!(d(&format!("<p>\nfixes {spelled}\n</p>")).text, "<p>\nfixes other/repo issue 3\n</p>", "{spelled}");
        }
    }

    #[test]
    fn closing_references_to_this_repository_stay_and_are_listed() {
        let i = d("fixes #12, Closes: #40\nRESOLVED acme/site#7 resolves https://github.com/ACME/site/pull/8");
        assert_eq!(i.text, "fixes #12, Closes: #40\nRESOLVED acme/site#7 resolves https://github.com/ACME/site/pull/8");
        assert_eq!(i.closes, ["#12", "#40", "#7", "#8"]);
        assert!(!i.changed());
        for k in KEYWORDS {
            assert_eq!(d(&format!("{k} #1")).closes, ["#1"], "{k}");
        }
        assert!(d("prefixes #1").closes.is_empty(), "a word ending in a keyword isn't one");
        assert!(d("fixes #12abc").closes.is_empty());
        // Every spelling of the `#`, and inside an HTML block: listed, as written.
        for spelled in ["\\#12", "&#35;12", "&#x23;12", "&num;12", "acme/site&#35;12"] {
            let text = format!("fixes {spelled}");
            let i = d(&text);
            assert_eq!((i.text.as_str(), i.closes.clone()), (text.as_str(), vec!["#12".to_string()]), "{spelled}");
            let html = format!("<details>\nfixes {spelled} and `fixes #13`\n</details>");
            assert_eq!(d(&html).closes, ["#12", "#13"], "{spelled}");
        }
    }

    #[test]
    fn comments_go_and_code_is_left_alone() {
        let i = d("a <!-- @x fixes o/r#1 --> b\n```\n@inside fixes o/r#2 <!-- kept -->\n```\n`@span` and ``fixes o/r#3``");
        assert_eq!(
            i.text,
            "a  b\n```\n@inside fixes o/r#2 <!-- kept -->\n```\n`@span` and ``fixes o/r#3``"
        );
        assert_eq!((i.comments, i.mentions, i.foreign_refs), (1, 0, 0));
        assert_eq!(d("before <!-- never closed @x").text, "before ");
        let tilde = d("~~~js\n@x\n~~~\n@y");
        assert_eq!(tilde.text, z("~~~js\n@x\n~~~\n@¦y"));
        // A comment block across a blank line: gone whole.
        assert_eq!(d("<!--\n\n@x\n\n-->\nshown").text, "\nshown");
    }

    #[test]
    fn it_is_idempotent_and_takes_a_long_body() {
        let long = "word @user fixes #1 ".repeat(3_000);
        assert!(long.len() >= 60_000);
        let i = d(&long);
        assert_eq!(i.mentions, 3_000);
        assert_eq!(i.closes.len(), 3_000);
        let again = d(&i.text);
        assert_eq!(again.text, i.text);
        assert_eq!(again.mentions, 0, "already inert: not counted again");
    }

    #[test]
    fn a_commit_message_closes_nothing_and_pings_nobody() {
        let c = |s: &str| make_inert(s, None, Kind::Commit).text;
        // The reference itself is broken: nothing links, nothing closes.
        for (from, to) in [
            ("Fix login, fixes #12 for @bob", z("Fix login, fixes issue 12 for @¦bob")),
            ("Fix login (closes #12)", "Fix login (closes issue 12)".to_string()),
            ("Fixes: #7", "Fixes: issue 7".to_string()),
            ("RESOLVES #7", "RESOLVES issue 7".to_string()),
            ("closes other/repo#3", "closes other/repo issue 3".to_string()),
            ("fixed https://github.com/o/r/issues/9", "fixed o/r issue 9".to_string()),
            ("resolved: https://github.com/o/r/pull/10.", "resolved: o/r issue 10.".to_string()),
            ("fixes &#35;5", "fixes issue 5".to_string()),
        ] {
            assert_eq!(c(from), to, "{from}");
            assert_eq!(c(&to), to, "idempotent: {to}");
        }
        assert_eq!(c("Bump #12"), "Bump #12", "no keyword: nothing to close");
    }

    #[test]
    fn a_code_span_never_crosses_a_blank_line() {
        let i = d("`\n\n@octocat fixes other/repo#3\n\n`");
        assert_eq!(i.text, z("\\`\n\n@¦octocat fixes other/repo issue 3\n\n\\`"));
        assert_eq!((i.mentions, i.foreign_refs), (1, 1));
        // Nor a line that starts another block.
        assert_eq!(d("`a\n# @octocat`").text, z("\\`a\n# @¦octocat\\`"));
        // Within a paragraph, it may run over a line.
        assert_eq!(d("`a\n@octocat`").text, "`a\n@octocat`");
    }

    #[test]
    fn a_lone_backtick_switches_nothing_off() {
        assert_eq!(d("`@octocat").text, z("\\`@¦octocat"));
        assert_eq!(d("``@octocat`").text, z("\\`\\`@¦octocat\\`"), "a run of two never closes at one");
        assert_eq!(d("`a`@octocat").text, z("`a`@¦octocat"));
    }

    #[test]
    fn fences_follow_commonmark() {
        // A Python decorator in a real fence: as it is.
        let py = "```python\n@app.route('/')\ndef home(): pass  # fixes other/repo#3\n```\n";
        assert_eq!(d(py).text, py);
        // And in a real code span.
        assert_eq!(d("use `@app.route('/')` here").text, "use `@app.route('/')` here");
        // Indented 4 spaces: not a fence (nor kept as code): prose.
        assert_eq!(d("    ```\n    @octocat\n    ```").text, z("    \\`\\`\\`\n    @¦octocat\n    \\`\\`\\`"));
        // An info string with a backtick: not a fence.
        assert!(d("```a`b\n@octocat\n```").text.contains(&z("@¦octocat")));
        // A closer of another character, shorter, or indented 4: still inside.
        let open = "~~~~\n@a\n```\n~~~\n    ~~~~\n@b\n~~~~\n@c";
        assert_eq!(d(open).text, z("~~~~\n@a\n```\n~~~\n    ~~~~\n@b\n~~~~\n@¦c"));
        // Up to 3 spaces of indent still opens one.
        assert_eq!(d("   ```\n@a\n   ```\n@b").text, z("   ```\n@a\n   ```\n@¦b"));
        // Never closed: code to the end, as GitHub shows it.
        assert_eq!(d("```\n@octocat fixes o/r#1").text, "```\n@octocat fixes o/r#1");
        // A fence line inside an HTML block isn't a fence.
        assert_eq!(d("<div>\n```\n@octocat\n```\n</div>").text, z("<div>\n```\n@¦octocat\n```\n</div>"));
    }

    #[test]
    fn a_mention_starts_after_any_non_word_character() {
        for (from, to) in [
            ("x.@octocat", "x.@¦octocat"),
            ("-@octocat", "-@¦octocat"),
            ("/@octocat", "/@¦octocat"),
            ("(@octocat", "(@¦octocat"),
            ("é@octocat", "é@¦octocat"),
            ("@octocat", "@¦octocat"),
        ] {
            assert_eq!(d(from).text, z(to), "{from}");
        }
        for word in ["a@octocat", "9@octocat", "_@octocat", "me@example.com"] {
            assert_eq!(d(word).text, word, "an email-like word");
        }
    }

    #[test]
    fn a_span_closes_only_at_a_run_of_the_same_length() {
        assert_eq!(d("`a``@octocat` b").text, "`a``@octocat` b", "one tick closes at one");
        assert_eq!(d("``a`@octocat`` b").text, "``a`@octocat`` b");
        assert_eq!(d("``a` @octocat").text, z("\\`\\`a\\` @¦octocat"));
    }

    #[test]
    fn removing_a_comment_never_makes_one_live() {
        assert_eq!(d("@<!-- x -->octocat").text, z("@¦octocat"));
        assert_eq!(d("<!<!-- x -->-- hidden -->shown").text, "shown");
    }

    #[test]
    fn html_is_noticed_never_stripped() {
        let i = d("<details><summary>More</summary>text</details>");
        assert!(i.html);
        assert_eq!(i.text, "<details><summary>More</summary>text</details>");
        assert!(!d("a < b and `<b>`").html, "a comparison, or code");
        assert!(!d("```\n<b>\n```").html);
    }

    #[test]
    fn every_case_is_idempotent() {
        for s in [
            "`\n\n@octocat fixes other/repo#3\n\n`",
            "`@octocat",
            "``@octocat`",
            "`a`@octocat",
            "\\@octocat &#64;a &#x40;b &commat;c &#0064;d",
            "<div>\n@a `@b` \\@c &#64;d fixes o/r&#35;1 fixes \\#2\n</div>",
            "    ```\n    @octocat\n    ```",
            "```a`b\n@octocat\n```",
            "~~~~\n@a\n```\n~~~\n    ~~~~\n@b\n~~~~\n@c",
            "x.@octocat -@a /@b (@c",
            "`a``@octocat` b",
            "``a` @octocat",
            "@<!-- x -->octocat",
            "fixes https://github.com/o/r/issues/3 fixes #4 @t/x fixes o/r&#x23;5",
            "```python\n@app.route('/')\n```",
        ] {
            let once = d(s);
            let twice = d(&once.text);
            assert_eq!(twice.text, once.text, "{s:?}");
            assert_eq!((twice.mentions, twice.foreign_refs), (0, 0), "{s:?}");
            assert_eq!(twice.closes, once.closes, "{s:?}");
            let commit = make_inert(s, None, Kind::Commit).text;
            assert_eq!(make_inert(&commit, None, Kind::Commit).text, commit, "{s:?}");
        }
    }
}
