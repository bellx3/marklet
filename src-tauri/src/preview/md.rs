//! 마크다운 → 블록 트리. 네이티브 뷰어(preview)가 그리는 모양이다.
//!
//! 렌더러(markdown-it)와 **같은 문서 구조**를 흉내 낸다 — 제목 · 문단 · 목록 · 인용 · 코드 · 표 · 가로줄 · 각주 · 앞머리(front matter).
//! 링크 · 그림 · 제목 id(목차와 문서 안 이동) · 코드 언어(색)까지 담는다. 수식과 Mermaid 는 그리지 못하므로 문서에 있는지만 알린다(`Features`) —
//! 있으면 앱이 WebView2 로 넘긴다.
//! ★ 원시 HTML 은 해석하지 않는다. 렌더러도 html:false 라 글자 그대로 보인다.

use std::collections::HashMap;
use std::sync::Arc;

use pulldown_cmark::{
    Alignment, CodeBlockKind, Event, LinkType, MetadataBlockKind, Options, Parser, Tag,
};

#[derive(Debug, Clone)]
pub enum Inline {
    Text(String),
    Code(String),
    Math(String),
    DisplayMath(String),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Strike(Vec<Inline>),
    Link {
        href: Arc<str>,
        children: Vec<Inline>,
    },
    Image {
        src: Arc<str>,
        alt: String,
    },
    FootnoteRef(usize),
    Break,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub task: Option<bool>,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone)]
pub enum Block {
    Heading {
        level: u8,
        inl: Vec<Inline>,
        /// 문서 안 이동 · 목차가 쓰는 id(렌더러의 markdown-it-anchor 와 같은 규칙). 비어 있으면 가리킬 수 없다.
        id: Arc<str>,
    },
    Paragraph(Vec<Inline>),
    /// 촘촘한 목록 항목 안의 글(문단 여백이 없다)
    Tight(Vec<Inline>),
    Code {
        /// 펜스의 언어(소문자, 없으면 빈 문자열)
        lang: String,
        text: String,
    },
    Math(String),
    Quote(Vec<Block>),
    List {
        ordered: bool,
        start: u64,
        items: Vec<Item>,
    },
    Table {
        aligns: Vec<Align>,
        head: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
    },
    Rule,
    FrontMatter(Vec<(String, String)>),
    /// 서식 없이 보여 주는 원문(`.txt` · 원문 보기)
    Plain(String),
    /// 아주 긴 문단을 잘라 놓은 앞 조각들 — 문단 여백 없이 이어진다(마지막 조각은 보통 문단이다).
    /// DirectWrite 는 한 글 덩어리가 길수록 배치가 급하게 느려진다(20만 자에 7초) — 조각으로 나누면 선형이고 첫 화면도 먼저 뜬다.
    Piece(Vec<Inline>),
    /// (파서 안에서만) 한 문단이 조각 여럿이 된 것 — blocks() 가 펴서 넣는다
    Group(Vec<Block>),
}

/// 문서의 제목 하나(목차용)
#[derive(Debug, Clone)]
pub struct Heading {
    pub level: u8,
    /// 글자만 남긴 제목
    pub text: String,
    pub id: Arc<str>,
}

/// 문서에 이런 것이 들어 있는가 — 네이티브로는 못 그리는 것이 있으면 앱이 WebView2 로 넘긴다.
#[derive(Debug, Default, Clone, Copy)]
pub struct Features {
    pub math: bool,
    pub mermaid: bool,
    /// 원격 그림(http · https)
    pub remote_images: bool,
    /// SVG 그림
    pub svg_images: bool,
    /// 이 뷰어가 감당하기 어려운 큰 덩어리(코드 60만 바이트 · 한 줄 16만 바이트)가 있다 — 한 덩어리를 통째로 놓아야 해서 배치가 몇 초씩 걸린다
    pub huge: bool,
}

impl Features {
    pub fn needs_web(&self) -> bool {
        self.math || self.mermaid || self.svg_images || self.huge
    }
}

/// 한 문단 조각의 크기(바이트). 한글 5천 자 남짓 — 배치 25ms 안팎이다.
const PIECE_BYTES: usize = 16 * 1024;
/// 코드 덩어리 · 한 줄의 상한(바이트) — 넘으면 웹이 그린다
const HUGE_CODE_BYTES: usize = 600 * 1024;
const HUGE_LINE_BYTES: usize = 160 * 1024;

pub struct Doc {
    pub blocks: Vec<Block>,
    /// 참조된 순서대로의 각주 정의
    pub footnotes: Vec<Vec<Block>>,
    pub headings: Vec<Heading>,
    pub features: Features,
}

type Iter<'a> = std::iter::Peekable<Parser<'a>>;

struct State {
    labels: Vec<String>,
    defs: HashMap<String, Vec<Block>>,
    slug_counts: HashMap<String, u32>,
    headings: Vec<Heading>,
    features: Features,
}

/// 서식 없이 보여 주는 문서(`.txt` · 원문 보기)
pub fn parse_plain(src: &str) -> Doc {
    Doc {
        blocks: vec![Block::Plain(src.to_string())],
        footnotes: Vec::new(),
        headings: Vec::new(),
        features: Features {
            huge: src.split('\n').any(|l| l.len() > HUGE_LINE_BYTES),
            ..Features::default()
        },
    }
}

pub fn parse(src: &str) -> Doc {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    opts.insert(Options::ENABLE_MATH);

    let mut it: Iter = Parser::new_ext(src, opts).peekable();
    let mut st = State {
        labels: Vec::new(),
        defs: HashMap::new(),
        slug_counts: HashMap::new(),
        headings: Vec::new(),
        features: Features::default(),
    };
    let blocks = blocks(&mut it, &mut st);
    let footnotes = st
        .labels
        .iter()
        .map(|l| st.defs.remove(l).unwrap_or_default())
        .collect();
    Doc {
        blocks,
        footnotes,
        headings: st.headings,
        features: st.features,
    }
}

/// 컨테이너 안의 블록들. 닫는 이벤트(End)를 만나면 그것까지 먹고 끝낸다(최상위는 이벤트가 다하면 끝).
fn blocks(it: &mut Iter, st: &mut State) -> Vec<Block> {
    let mut out = Vec::new();
    while let Some(ev) = it.peek() {
        match ev {
            Event::End(_) => {
                it.next();
                break;
            }
            Event::Start(t) if !is_inline_tag(t) => {
                if let Some(b) = block(it, st) {
                    push_block(&mut out, b);
                }
            }
            Event::Rule | Event::DisplayMath(_) | Event::Html(_) => {
                if let Some(b) = block(it, st) {
                    push_block(&mut out, b);
                }
            }
            // 촘촘한 항목 안의 글: 문단 시작 없이 인라인 이벤트가 바로 온다.
            _ => {
                let inl = inlines_until_block(it, st);
                if !inl.is_empty() {
                    split_into(&mut out, finish(inl), true);
                }
            }
        }
    }
    out
}

fn block(it: &mut Iter, st: &mut State) -> Option<Block> {
    match it.next()? {
        Event::Rule => Some(Block::Rule),
        Event::DisplayMath(s) => {
            st.features.math = true;
            Some(Block::Math(s.to_string()))
        }
        Event::Html(s) => Some(html_paragraph(&s)),
        Event::Start(tag) => match tag {
            Tag::Paragraph => {
                let inl = inlines(it, st);
                // `$$ … $$` 한 줄만 있는 문단은 수식 블록이다.
                if let [Inline::DisplayMath(m)] = inl.as_slice() {
                    return Some(Block::Math(m.trim().to_string()));
                }
                // 아주 긴 문단은 조각으로 나눈다(여럿이 되면 묶어서 돌려주고 blocks() 가 편다)
                let mut parts = Vec::new();
                split_into(&mut parts, finish(inl), false);
                if parts.len() == 1 {
                    parts.pop()
                } else {
                    Some(Block::Group(parts))
                }
            }
            Tag::Heading { level, .. } => {
                let inl = finish(inlines(it, st));
                let text = slug_text(&inl);
                let id = unique_slug(&text, &mut st.slug_counts);
                let id: Arc<str> = id.into();
                st.headings.push(Heading {
                    level: level as u8,
                    text: plain(&inl).trim().to_string(),
                    id: id.clone(),
                });
                Some(Block::Heading {
                    level: level as u8,
                    inl,
                    id,
                })
            }
            Tag::BlockQuote(_) => Some(Block::Quote(blocks(it, st))),
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => language_of(&info),
                    CodeBlockKind::Indented => String::new(),
                };
                if lang == "mermaid" {
                    st.features.mermaid = true;
                }
                let mut text = String::new();
                for ev in it.by_ref() {
                    match ev {
                        Event::Text(t) => text.push_str(&t),
                        Event::End(_) => break,
                        _ => {}
                    }
                }
                if text.ends_with('\n') {
                    text.pop();
                }
                if text.len() > HUGE_CODE_BYTES
                    || text.split('\n').any(|l| l.len() > HUGE_LINE_BYTES)
                {
                    st.features.huge = true;
                }
                Some(Block::Code { lang, text })
            }
            Tag::List(first) => {
                let ordered = first.is_some();
                let start = first.unwrap_or(1);
                let mut items = Vec::new();
                while let Some(ev) = it.peek() {
                    match ev {
                        Event::Start(Tag::Item) => {
                            it.next();
                            let mut task = None;
                            if let Some(Event::TaskListMarker(b)) = it.peek() {
                                task = Some(*b);
                                it.next();
                            }
                            items.push(Item {
                                task,
                                blocks: blocks(it, st),
                            });
                        }
                        Event::End(_) => {
                            it.next();
                            break;
                        }
                        _ => {
                            it.next();
                        }
                    }
                }
                Some(Block::List {
                    ordered,
                    start,
                    items,
                })
            }
            Tag::Table(aligns) => {
                let aligns: Vec<Align> = aligns
                    .iter()
                    .map(|a| match a {
                        Alignment::Center => Align::Center,
                        Alignment::Right => Align::Right,
                        _ => Align::Left,
                    })
                    .collect();
                let mut head: Vec<Vec<Inline>> = Vec::new();
                let mut rows: Vec<Vec<Vec<Inline>>> = Vec::new();
                while let Some(ev) = it.next() {
                    match ev {
                        Event::Start(Tag::TableHead) => head = cells(it, st),
                        Event::Start(Tag::TableRow) => rows.push(cells(it, st)),
                        Event::End(_) => break,
                        _ => {}
                    }
                }
                Some(Block::Table { aligns, head, rows })
            }
            Tag::FootnoteDefinition(label) => {
                let b = blocks(it, st);
                st.defs.insert(label.to_string(), b);
                None
            }
            Tag::MetadataBlock(MetadataBlockKind::YamlStyle)
            | Tag::MetadataBlock(MetadataBlockKind::PlusesStyle) => {
                let mut text = String::new();
                for ev in it.by_ref() {
                    match ev {
                        Event::Text(t) => text.push_str(&t),
                        Event::End(_) => break,
                        _ => {}
                    }
                }
                Some(Block::FrontMatter(simple_yaml(&text)))
            }
            Tag::HtmlBlock => {
                let mut text = String::new();
                for ev in it.by_ref() {
                    match ev {
                        Event::Html(t) | Event::Text(t) => text.push_str(&t),
                        Event::End(_) => break,
                        _ => {}
                    }
                }
                Some(html_paragraph(text.trim_end()))
            }
            // 알 수 없는 컨테이너: 안의 글만 건진다
            _ => {
                let inl = inlines(it, st);
                if inl.is_empty() {
                    None
                } else {
                    Some(Block::Paragraph(finish(inl)))
                }
            }
        },
        _ => None,
    }
}

fn push_block(out: &mut Vec<Block>, b: Block) {
    match b {
        Block::Group(v) => out.extend(v),
        other => out.push(other),
    }
}

/// 문단(또는 촘촘한 항목의 글)을 넣는다. 아주 길면 조각으로 나눠 앞 조각들은 `Piece`, 마지막은 문단 · 항목글로.
fn split_into(out: &mut Vec<Block>, inl: Vec<Inline>, tight: bool) {
    let mut parts = split_long(inl);
    let last = parts.pop().unwrap_or_default();
    for p in parts {
        out.push(Block::Piece(p));
    }
    out.push(if tight {
        Block::Tight(last)
    } else {
        Block::Paragraph(last)
    });
}

fn inline_bytes(inl: &[Inline]) -> usize {
    inl.iter()
        .map(|i| match i {
            Inline::Text(t) | Inline::Code(t) | Inline::Math(t) | Inline::DisplayMath(t) => t.len(),
            Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => inline_bytes(c),
            Inline::Link { children, .. } => inline_bytes(children),
            Inline::Image { alt, .. } => alt.len(),
            _ => 1,
        })
        .sum()
}

/// 긴 글을 조각(PIECE_BYTES 안팎)으로 자른다. 맨 앞 가지의 `Text` 만 쪼갠다 — 아주 긴 글은 거의 맨 글이다. 항상 하나 이상을 돌려준다.
fn split_long(inl: Vec<Inline>) -> Vec<Vec<Inline>> {
    if inline_bytes(&inl) <= PIECE_BYTES * 2 {
        return vec![inl];
    }
    let mut out: Vec<Vec<Inline>> = Vec::new();
    let mut cur: Vec<Inline> = Vec::new();
    let mut cur_bytes = 0usize;
    for node in inl {
        let Inline::Text(t) = node else {
            let n = inline_bytes(std::slice::from_ref(&node));
            if cur_bytes + n > PIECE_BYTES && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
                cur_bytes = 0;
            }
            cur_bytes += n;
            cur.push(node);
            continue;
        };
        let mut rest: &str = &t;
        while !rest.is_empty() {
            let room = PIECE_BYTES.saturating_sub(cur_bytes);
            if rest.len() <= room.max(1) {
                cur_bytes += rest.len();
                cur.push(Inline::Text(rest.to_string()));
                break;
            }
            // 남은 자리 안에서 공백 뒤로 자른다(없으면 글자 경계에서)
            let want = room.max(PIECE_BYTES / 2);
            let mut cut = want.min(rest.len());
            while !rest.is_char_boundary(cut) {
                cut -= 1;
            }
            if let Some(sp) = rest[..cut].rfind([' ', '\t']) {
                if sp > cut / 2 {
                    cut = sp + 1;
                }
            }
            cur.push(Inline::Text(rest[..cut].to_string()));
            out.push(std::mem::take(&mut cur));
            cur_bytes = 0;
            rest = &rest[cut..];
        }
    }
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

/// 원시 HTML 은 글자 그대로 보인다(렌더러가 html:false) — 본문 글자 모양의 문단이다. 줄바꿈은 그대로.
fn html_paragraph(raw: &str) -> Block {
    let mut out: Vec<Inline> = Vec::new();
    for (i, line) in raw.trim_end_matches('\n').split('\n').enumerate() {
        if i > 0 {
            out.push(Inline::Break);
        }
        push_text(&mut out, line);
    }
    Block::Paragraph(out)
}

/// 표의 한 줄(머리 또는 본문). 닫는 이벤트까지.
fn cells(it: &mut Iter, st: &mut State) -> Vec<Vec<Inline>> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(Tag::TableCell) => out.push(finish(inlines(it, st))),
            Event::End(_) => break,
            _ => {}
        }
    }
    out
}

/// 한 컨테이너 안의 인라인들. 닫는 이벤트까지 먹는다.
fn inlines(it: &mut Iter, st: &mut State) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(_) => break,
            ev => push_inline(ev, it, st, &mut out),
        }
    }
    out
}

/// 글줄 안에서 열리는 태그인가(강조 · 링크 · 그림 …). 이것으로 시작하는 촘촘한 항목은 문단으로 쪼개지 않는다.
fn is_inline_tag(t: &Tag) -> bool {
    matches!(
        t,
        Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Superscript
            | Tag::Subscript
            | Tag::Link { .. }
            | Tag::Image { .. }
    )
}

/// 블록 이벤트(Start 중 블록 · End · Rule)가 나오기 전까지의 인라인들(닫는 이벤트는 먹지 않는다).
fn inlines_until_block(it: &mut Iter, st: &mut State) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    while let Some(ev) = it.peek() {
        let is_block = match ev {
            Event::End(_) | Event::Rule | Event::DisplayMath(_) => true,
            Event::Start(t) => !is_inline_tag(t),
            _ => false,
        };
        if is_block {
            break;
        }
        let ev = it.next().unwrap();
        push_inline(ev, it, st, &mut out);
    }
    out
}

fn push_inline(ev: Event, it: &mut Iter, st: &mut State, out: &mut Vec<Inline>) {
    match ev {
        Event::Text(t) => push_text(out, &t),
        Event::Code(c) => out.push(Inline::Code(c.to_string())),
        Event::InlineMath(m) => {
            st.features.math = true;
            out.push(Inline::Math(m.to_string()))
        }
        Event::DisplayMath(m) => {
            st.features.math = true;
            out.push(Inline::DisplayMath(m.to_string()))
        }
        Event::Html(h) | Event::InlineHtml(h) => push_text(out, &h),
        // 렌더러는 줄바꿈을 그대로 둔다(설정 '한 줄 개행 유지'의 기본값).
        Event::SoftBreak | Event::HardBreak => out.push(Inline::Break),
        Event::FootnoteReference(label) => {
            let label = label.to_string();
            let idx = match st.labels.iter().position(|l| *l == label) {
                Some(i) => i,
                None => {
                    st.labels.push(label);
                    st.labels.len() - 1
                }
            };
            out.push(Inline::FootnoteRef(idx + 1));
        }
        Event::Start(Tag::Emphasis) => out.push(Inline::Em(inlines(it, st))),
        Event::Start(Tag::Strong) => out.push(Inline::Strong(inlines(it, st))),
        Event::Start(Tag::Strikethrough) => out.push(Inline::Strike(inlines(it, st))),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            ..
        }) => {
            let children = inlines(it, st);
            let mut href = dest_url.to_string();
            if link_type == LinkType::Email && !href.to_ascii_lowercase().starts_with("mailto:") {
                href = format!("mailto:{href}");
            }
            if is_safe_url(&href) {
                out.push(Inline::Link {
                    href: href.into(),
                    children,
                });
            } else {
                // 렌더러(markdown-it)는 허용 목록 밖의 주소를 링크로 만들지 않는다 — 글자만 남긴다.
                out.extend(children);
            }
        }
        Event::Start(Tag::Image { dest_url, .. }) => {
            let alt = plain(&inlines(it, st));
            let src = dest_url.to_string();
            if is_safe_url(&src) {
                if is_remote(&src) {
                    st.features.remote_images = true;
                }
                if is_svg(&src) {
                    st.features.svg_images = true;
                }
                out.push(Inline::Image {
                    src: src.into(),
                    alt,
                });
            } else {
                push_text(out, &alt);
            }
        }
        // 그 밖의 시작 이벤트(위첨자 등)는 안의 글만 건진다
        Event::Start(_) => {
            let inner = inlines(it, st);
            out.extend(inner);
        }
        _ => {}
    }
}

fn push_text(out: &mut Vec<Inline>, t: &str) {
    if let Some(Inline::Text(prev)) = out.last_mut() {
        prev.push_str(t);
    } else {
        out.push(Inline::Text(t.to_string()));
    }
}

/// 문단 하나의 인라인이 다 모였다 — 맨 글에서 주소를 찾아 링크로 바꾼다(렌더러의 linkify).
fn finish(inl: Vec<Inline>) -> Vec<Inline> {
    linkify_all(inl, false)
}

// ── 주소 검사 ─────────────────────────────────────────────────────────────

/// 링크 · 그림 주소 허용 목록(src/markdown/sanitize.ts 의 isSafeUrl 과 같다. 데스크톱은 상대 주소를 허용한다).
pub fn is_safe_url(url: &str) -> bool {
    let u = url.trim();
    safe_absolute(u) || relative_ok(u)
}

fn safe_absolute(u: &str) -> bool {
    let lower = u.to_ascii_lowercase();
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
        || u.starts_with('#')
    {
        return true;
    }
    // `\.{0,2}\/(?![/\\])` — `/x` · `./x` · `../x`. 뒤에 `/` 나 `\` 가 또 오면(프로토콜 상대 `//host`) 안 된다.
    let dots = u.bytes().take_while(|b| *b == b'.').count();
    if dots > 2 {
        return false;
    }
    let rest = &u[dots..];
    match rest.strip_prefix('/') {
        Some(after) => !(after.starts_with('/') || after.starts_with('\\')),
        None => false,
    }
}

fn relative_ok(u: &str) -> bool {
    let b = u.as_bytes();
    // `[/\\]{2}` 로 시작하거나 `\` 하나로 시작하면 안 된다(네트워크 경로)
    if b.first() == Some(&b'\\') {
        return false;
    }
    if b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\') {
        return false;
    }
    // `[^:/?#]*` 다음에 `/ ? #` 가 오거나 끝이어야 한다 — 즉 첫 `/ ? #` 앞에 `:` 가 없어야 한다.
    for c in u.chars() {
        match c {
            ':' => return false,
            '/' | '?' | '#' => return true,
            _ => {}
        }
    }
    true
}

pub fn is_remote(src: &str) -> bool {
    let l = src.trim().to_ascii_lowercase();
    l.starts_with("http:") || l.starts_with("https:")
}

fn is_svg(src: &str) -> bool {
    let end = src.find(['?', '#']).unwrap_or(src.len());
    src[..end].to_ascii_lowercase().ends_with(".svg")
}

/// 펜스 정보에서 언어 이름만(```ts {1,3} 같은 꼬리표도 받는다).
fn language_of(info: &str) -> String {
    info.trim()
        .to_lowercase()
        .split(|c: char| c.is_whitespace() || c == ',' || c == '{')
        .next()
        .unwrap_or("")
        .to_string()
}

// ── linkify: 맨 주소를 링크로 ─────────────────────────────────────────────────

fn linkify_all(inl: Vec<Inline>, inside_link: bool) -> Vec<Inline> {
    let mut out = Vec::with_capacity(inl.len());
    for i in inl {
        match i {
            Inline::Text(t) if !inside_link => out.extend(linkify_text(&t)),
            Inline::Strong(c) => out.push(Inline::Strong(linkify_all(c, inside_link))),
            Inline::Em(c) => out.push(Inline::Em(linkify_all(c, inside_link))),
            Inline::Strike(c) => out.push(Inline::Strike(linkify_all(c, inside_link))),
            // 링크 안의 글은 이미 링크다
            other => out.push(other),
        }
    }
    out
}

fn is_url_char_stop(c: char) -> bool {
    c.is_whitespace() || matches!(c, '<' | '>' | '"' | '`' | '\u{2060}')
}

/// 글 하나에서 `http(s)://…` · `www.…` · 메일 주소를 찾아 링크로 쪼갠다.
pub fn linkify_text(text: &str) -> Vec<Inline> {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out: Vec<Inline> = Vec::new();
    let mut last = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        // 후보는 단어 경계에서만(앞 글자가 영숫자 · `/` · `@` 이면 건너뛴다)
        let boundary = i == 0 || {
            let p = text[..i].chars().next_back().unwrap_or(' ');
            !(p.is_alphanumeric() || matches!(p, '/' | '@' | '.' | '-' | '_'))
        };
        let scheme = if boundary {
            if lower[i..].starts_with("https://") {
                Some(8)
            } else if lower[i..].starts_with("http://") {
                Some(7)
            } else if lower[i..].starts_with("www.") {
                Some(0)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(head) = scheme {
            let tail_start = i + head;
            // 주소는 공백 · `<>"` 앞까지
            let mut end = tail_start;
            for (off, c) in text[tail_start..].char_indices() {
                if is_url_char_stop(c) {
                    break;
                }
                end = tail_start + off + c.len_utf8();
            }
            let end = trim_url_end(&text[i..end]) + i;
            let body = &text[tail_start..end];
            // 스킴 뒤에 글자가 있어야 하고(`www.` 는 점 다음에도 한 글자 이상)
            let ok = if head == 0 {
                body.len() > 4 && body[4..].chars().any(|c| c.is_alphanumeric())
            } else {
                body.chars().any(|c| c.is_alphanumeric())
            };
            if ok {
                if i > last {
                    out.push(Inline::Text(text[last..i].to_string()));
                }
                let label = text[i..end].to_string();
                let href = if head == 0 {
                    format!("http://{label}")
                } else {
                    label.clone()
                };
                out.push(Inline::Link {
                    href: href.into(),
                    children: vec![Inline::Text(label)],
                });
                last = end;
                i = end;
                continue;
            }
        }
        // 메일 주소: 이름@도메인.최상위
        if bytes[i] == b'@' && i > 0 {
            if let Some((s, e)) = email_span(text, i) {
                if s >= last {
                    if s > last {
                        out.push(Inline::Text(text[last..s].to_string()));
                    }
                    let label = text[s..e].to_string();
                    out.push(Inline::Link {
                        href: format!("mailto:{label}").into(),
                        children: vec![Inline::Text(label)],
                    });
                    last = e;
                    i = e;
                    continue;
                }
            }
        }
        // 다음 글자로(UTF-8 경계를 지킨다)
        i += text[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
    if out.is_empty() {
        return vec![Inline::Text(text.to_string())];
    }
    if last < text.len() {
        out.push(Inline::Text(text[last..].to_string()));
    }
    out
}

/// 주소 끝에 붙은 문장부호를 뗀 길이. 짝이 맞는 닫는 괄호는 남긴다.
fn trim_url_end(url: &str) -> usize {
    let mut end = url.len();
    while let Some(c) = url[..end].chars().next_back() {
        let cut = match c {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '*' | '~' => true,
            ')' => url[..end].matches('(').count() < url[..end].matches(')').count(),
            ']' => url[..end].matches('[').count() < url[..end].matches(']').count(),
            '}' => url[..end].matches('{').count() < url[..end].matches('}').count(),
            // 한글 조사 등 주소가 아닐 법한 글자가 붙은 경우는 그대로 둔다(렌더러도 그렇다)
            _ => false,
        };
        if !cut {
            break;
        }
        end -= c.len_utf8();
    }
    end
}

/// `@` 가 있는 자리(at)를 가운데로 하는 메일 주소의 [시작, 끝) 바이트. 아니면 None.
fn email_span(text: &str, at: usize) -> Option<(usize, usize)> {
    let local_ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-');
    let mut start = at;
    for (off, c) in text[..at].char_indices().rev() {
        if local_ok(c) {
            start = off;
        } else {
            break;
        }
    }
    if start == at {
        return None;
    }
    let dom_ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-');
    let mut end = at + 1;
    for (off, c) in text[at + 1..].char_indices() {
        if dom_ok(c) {
            end = at + 1 + off + c.len_utf8();
        } else {
            break;
        }
    }
    // 끝의 점은 문장부호다
    while text[..end].ends_with('.') {
        end -= 1;
    }
    let domain = &text[at + 1..end];
    let last_dot = domain.rfind('.')?;
    let tld = &domain[last_dot + 1..];
    if domain.starts_with('.') || tld.len() < 2 || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    // 이름 쪽이 점으로 시작하면 점을 뗀다
    let mut s = start;
    while text[s..].starts_with('.') {
        s += 1;
    }
    if s >= at {
        return None;
    }
    Some((s, end))
}

// ── 제목 id (src/markdown/renderer.ts 의 slugify · slugifyWithState) ─────────────

/// 제목에서 id 에 쓸 글자 — 글 · 인라인 코드의 내용만(강조 표시 · 그림 · 각주는 뺀다).
fn slug_text(inl: &[Inline]) -> String {
    let mut s = String::new();
    for i in inl {
        match i {
            Inline::Text(t) | Inline::Code(t) => s.push_str(t),
            Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => s.push_str(&slug_text(c)),
            Inline::Link { children, .. } => s.push_str(&slug_text(children)),
            _ => {}
        }
    }
    s
}

/// `encodeURIComponent` 와 같다(`A-Z a-z 0-9 - _ . ! ~ * ' ( )` 는 그대로).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`. 잘못된 `%xx` · UTF-8 이면 None.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hi = (*b.get(i + 1)? as char).to_digit(16)?;
            let lo = (*b.get(i + 2)? as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn slugify(title: &str) -> String {
    let mut buf = String::new();
    let mut prev_space = false;
    for c in title.trim().to_lowercase().chars() {
        if c.is_whitespace() {
            if !prev_space {
                buf.push('-');
            }
            prev_space = true;
            continue;
        }
        prev_space = false;
        if matches!(
            c,
            '?' | '!' | '.' | ',' | ':' | ';' | '\'' | '"' | '(' | ')' | '[' | ']' | '{' | '}'
        ) {
            continue;
        }
        buf.push(c);
    }
    encode_uri_component(&buf)
}

/// 같은 제목이 겹치면 `제목`, `제목-1`, `제목-2` … 로 번호를 매긴다.
fn unique_slug(title: &str, counts: &mut HashMap<String, u32>) -> String {
    let base = slugify(title);
    let seen = counts.entry(base.clone()).or_insert(0);
    let id = if *seen == 0 {
        base
    } else {
        format!("{base}-{seen}")
    };
    *seen += 1;
    id
}

/// 인라인을 글자만 남겨 편다(그림 대체 글 · 표 칸 너비 계산용).
pub fn plain(inl: &[Inline]) -> String {
    let mut s = String::new();
    for i in inl {
        match i {
            Inline::Text(t) | Inline::Code(t) | Inline::Math(t) | Inline::DisplayMath(t) => {
                s.push_str(t)
            }
            Inline::Image { alt, .. } => s.push_str(alt),
            Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => s.push_str(&plain(c)),
            Inline::Link { children, .. } => s.push_str(&plain(children)),
            Inline::FootnoteRef(n) => s.push_str(&n.to_string()),
            Inline::Break => s.push('\n'),
        }
    }
    s
}

/// 앞머리(front matter)의 `키: 값` 줄을 읽는다. 렌더러는 js-yaml 로 읽어 배열을 `a, b` 로 잇는다 — 뷰어도 같은 모양으로 보인다:
/// 한 줄 배열(`[a, b]`)과 아래 줄의 `- 항목` 목록을 쉼표로 잇고, 따옴표는 벗긴다. 중첩 매핑 · 여러 줄 글은 읽지 않는다.
fn simple_yaml(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    // 값이 비어 있는 직전 키(아래 줄의 `- 항목` 들이 이어진다)
    let mut open_list: Option<usize> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented || trimmed.starts_with("- ") || trimmed == "-" {
            if let (Some(i), Some(item)) = (open_list, trimmed.strip_prefix('-')) {
                let item = unquote(item.trim());
                if !item.is_empty() {
                    let v = &mut out[i].1;
                    if !v.is_empty() {
                        v.push_str(", ");
                    }
                    v.push_str(&item);
                }
            }
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim();
        if k.is_empty() || k.contains(' ') && k.is_ascii() {
            continue;
        }
        let v = v.trim();
        let value = if let Some(inner) = v.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            inner
                .split(',')
                .map(|x| unquote(x.trim()))
                .filter(|x| !x.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            unquote(v)
        };
        open_list = if v.is_empty() { Some(out.len()) } else { None };
        out.push((k.to_string(), value));
    }
    out
}

fn unquote(v: &str) -> String {
    v.trim_matches(|c| c == '"' || c == '\'').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_structure() {
        let d = parse(
            "---\ntitle: 제목\nstatus: 검토 중\n---\n\n# 큰 제목\n\n본문 **굵게** `코드`[^1]\n둘째 줄\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |\n\n- [x] 끝\n- [ ] 아직\n\n1. 하나\n2. 둘\n\n> 인용\n\n```ts\nlet a = 1;\n```\n\n$$x^2$$\n\n---\n\n[^1]: 각주\n",
        );
        let kinds: Vec<&str> = d
            .blocks
            .iter()
            .map(|b| match b {
                Block::FrontMatter(_) => "fm",
                Block::Heading { .. } => "h",
                Block::Paragraph(_) => "p",
                Block::Table { .. } => "table",
                Block::List { ordered: false, .. } => "ul",
                Block::List { ordered: true, .. } => "ol",
                Block::Quote(_) => "quote",
                Block::Code { .. } => "code",
                Block::Math(_) => "math",
                Block::Rule => "hr",
                _ => "?",
            })
            .collect();
        assert_eq!(
            kinds,
            ["fm", "h", "p", "table", "ul", "ol", "quote", "code", "math", "hr"]
        );
        assert_eq!(d.footnotes.len(), 1);
        assert!(d.features.math);
        if let Block::FrontMatter(kv) = &d.blocks[0] {
            assert_eq!(kv[0], ("title".to_string(), "제목".to_string()));
            assert_eq!(kv.len(), 2);
        }
        if let Block::List { items, .. } = &d.blocks[4] {
            assert_eq!(items[0].task, Some(true));
            assert_eq!(items[1].task, Some(false));
        }
        if let Block::Table { aligns, head, rows } = &d.blocks[3] {
            assert_eq!(aligns, &[Align::Left, Align::Right]);
            assert_eq!((head.len(), rows.len()), (2, 1));
        }
        // 줄바꿈은 그대로, 각주 참조는 번호로
        if let Block::Paragraph(inl) = &d.blocks[2] {
            assert!(inl.iter().any(|i| matches!(i, Inline::Break)));
            assert!(inl.iter().any(|i| matches!(i, Inline::FootnoteRef(1))));
        }
    }

    #[test]
    fn tight_item_starting_with_emphasis_stays_one_block() {
        // 예전에는 **굵게** 로 시작하는 항목이 문단 둘로 쪼개져 높이가 어긋났다.
        let d = parse(
            "- **굵게** — 나머지 글
- *기울임*으로 시작
- [링크](x) 뒤 글
",
        );
        let Block::List { items, .. } = &d.blocks[0] else {
            panic!("목록이어야 한다")
        };
        assert_eq!(items.len(), 3);
        for it in items {
            assert_eq!(it.blocks.len(), 1, "{it:?}");
            assert!(matches!(it.blocks[0], Block::Tight(_)));
        }
    }

    #[test]
    fn nested_and_loose_lists_do_not_swallow_following_blocks() {
        let d = parse("- a\n  - b\n  - c\n- d\n\n끝 문단\n");
        assert!(matches!(d.blocks[0], Block::List { .. }));
        assert!(matches!(d.blocks[1], Block::Paragraph(_)));
        if let Block::List { items, .. } = &d.blocks[0] {
            assert_eq!(items.len(), 2);
            assert!(items[0]
                .blocks
                .iter()
                .any(|b| matches!(b, Block::List { .. })));
        }
    }

    #[test]
    fn links_and_images_keep_their_addresses() {
        let d = parse("[문서](https://a.example/x) 와 [내부](#절) 와 ![그림](img/a.png \"t\")\n");
        let Block::Paragraph(inl) = &d.blocks[0] else {
            panic!()
        };
        let hrefs: Vec<&str> = inl
            .iter()
            .filter_map(|i| match i {
                Inline::Link { href, .. } => Some(&**href),
                _ => None,
            })
            .collect();
        assert_eq!(hrefs, ["https://a.example/x", "#절"]);
        assert!(inl.iter().any(
            |i| matches!(i, Inline::Image { src, alt } if &**src == "img/a.png" && alt == "그림")
        ));
        assert!(!d.features.remote_images && !d.features.needs_web());
    }

    #[test]
    fn unsafe_links_lose_their_link_but_keep_their_text() {
        let d = parse("[누르면](javascript:alert(1)) 와 [x](C:\\a.md) 와 [y](//evil/x)\n");
        let Block::Paragraph(inl) = &d.blocks[0] else {
            panic!()
        };
        assert!(!inl.iter().any(|i| matches!(i, Inline::Link { .. })));
        assert!(plain(inl).contains("누르면"));
    }

    #[test]
    fn safe_url_rules_match_the_renderer() {
        for ok in [
            "https://a.b",
            "HTTP://a.b",
            "mailto:a@b.c",
            "tel:1",
            "#x",
            "/x",
            "./x",
            "../x",
            "a.md",
            "img/a.png",
            "a b.png",
            "x?y",
        ] {
            assert!(is_safe_url(ok), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///C:/x",
            "C:\\x",
            "//host/x",
            "\\\\host\\x",
            "\\x",
            "/\\host",
            "capacitor://x",
            "java\tscript:alert(1)",
        ] {
            assert!(!is_safe_url(bad), "{bad}");
        }
    }

    #[test]
    fn heading_ids_follow_the_renderer_and_count_duplicates() {
        let d = parse("# Hello, World!\n\n## 한글 제목\n\n## 한글 제목\n\n## 한글 제목\n\n### `코드` 와 **굵게**\n");
        let ids: Vec<&str> = d.headings.iter().map(|h| &*h.id).collect();
        assert_eq!(ids[0], "hello-world");
        assert_eq!(ids[1], encode_uri_component("한글-제목"));
        assert_eq!(ids[2], format!("{}-1", encode_uri_component("한글-제목")));
        assert_eq!(ids[3], format!("{}-2", encode_uri_component("한글-제목")));
        assert_eq!(ids[4], encode_uri_component("코드-와-굵게"));
        assert_eq!(d.headings[1].text, "한글 제목");
        assert_eq!(d.headings[1].level, 2);
        assert_eq!(
            decode_uri_component(&d.headings[1].id).unwrap(),
            "한글-제목"
        );
    }

    #[test]
    fn code_language_and_features_are_reported() {
        let d = parse("```ts {1,3}\nlet a;\n```\n\n```mermaid\ngraph TD\n```\n\n![x](https://a/b.png) ![y](a.SVG?x)\n");
        let langs: Vec<&str> = d
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Code { lang, .. } => Some(lang.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(langs, ["ts", "mermaid"]);
        assert!(d.features.mermaid && d.features.remote_images && d.features.svg_images);
        assert!(d.features.needs_web());
    }

    #[test]
    fn bare_urls_become_links_but_not_inside_code_or_links() {
        let d = parse("주소는 https://example.com/a?b=1, 그리고 www.rust-lang.org. (http://x.y/z) `https://no.link` [t](https://l.k) a@b.co\n");
        let Block::Paragraph(inl) = &d.blocks[0] else {
            panic!()
        };
        let links: Vec<(String, String)> = inl
            .iter()
            .filter_map(|i| match i {
                Inline::Link { href, children } => Some((href.to_string(), plain(children))),
                _ => None,
            })
            .collect();
        assert_eq!(
            links,
            [
                (
                    "https://example.com/a?b=1".to_string(),
                    "https://example.com/a?b=1".to_string()
                ),
                (
                    "http://www.rust-lang.org".to_string(),
                    "www.rust-lang.org".to_string()
                ),
                ("http://x.y/z".to_string(), "http://x.y/z".to_string()),
                ("https://l.k".to_string(), "t".to_string()),
                ("mailto:a@b.co".to_string(), "a@b.co".to_string()),
            ]
        );
    }

    #[test]
    fn plain_text_without_urls_is_untouched() {
        let v = linkify_text("그냥 글입니다. README.md 와 a.b 와 호출(f) 입니다.");
        assert_eq!(v.len(), 1);
        assert!(matches!(&v[0], Inline::Text(t) if t.contains("README.md")));
    }

    #[test]
    fn a_giant_paragraph_is_split_into_pieces_that_rejoin_losslessly() {
        let src = format!("{}\n", "한글 단어 word ".repeat(12_000));
        let d = parse(&src);
        let mut text = String::new();
        let mut n_piece = 0;
        for b in &d.blocks {
            match b {
                Block::Piece(i) => {
                    n_piece += 1;
                    text.push_str(&plain(i));
                }
                Block::Paragraph(i) => text.push_str(&plain(i)),
                other => panic!("뜻밖의 블록 {other:?}"),
            }
        }
        assert!(n_piece >= 5, "{n_piece}");
        // (파서는 문단 끝의 공백을 뗀다)
        let want = src.trim_end();
        let first_diff = text.chars().zip(want.chars()).position(|(a, b)| a != b);
        assert!(
            text == want,
            "조각을 이으면 원문이 그대로여야 한다 — 길이 {} / {}, 처음 다른 글자 {:?}",
            text.len(),
            want.len(),
            first_diff
        );
        // 짧은 문단은 그대로 하나
        assert_eq!(parse("짧다\n").blocks.len(), 1);
    }

    #[test]
    fn huge_code_or_lines_ask_for_the_web_renderer() {
        let big = format!("```\n{}\n```\n", "x".repeat(170 * 1024));
        assert!(parse(&big).features.huge && parse(&big).features.needs_web());
        let many = format!("```\n{}\n```\n", "ab\n".repeat(250_000));
        assert!(parse(&many).features.huge);
        assert!(!parse("```\nlet a = 1;\n```\n").features.huge);
        assert!(parse_plain(&"y".repeat(170 * 1024)).features.huge);
    }

    #[test]
    fn front_matter_arrays_are_joined_like_the_renderer() {
        let d = parse("---\ntitle: \"제목\"\ntags: [a, 'b', c]\nlist:\n  - 하나\n  - 둘\nempty:\n---\n\n본문\n");
        let Block::FrontMatter(kv) = &d.blocks[0] else {
            panic!()
        };
        let get = |k: &str| kv.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
        assert_eq!(get("title"), Some("제목"));
        assert_eq!(get("tags"), Some("a, b, c"));
        assert_eq!(get("list"), Some("하나, 둘"));
        assert_eq!(get("empty"), Some(""));
    }

    #[test]
    fn html_is_shown_as_text_in_a_paragraph() {
        let d = parse("<div>안녕</div>\n\n본문\n");
        assert!(matches!(&d.blocks[0], Block::Paragraph(i) if plain(i).contains("<div>")));
    }
}
