//! 블록 트리 → 그릴 것들(글 · 상자 · 선 · 그림). DirectWrite 로 글을 배치한다.
//!
//! 수치는 렌더러(src/styles/markdown.css · desktop.css)가 **실제로 계산한 값**을 그대로 옮긴 것이다
//! (본문 17px · 줄 높이 1.75 · 제목 1.7/1.4/1.2/1.05em · 여백 · 표 · 코드 상자 …).
//! 좌표는 CSS px 이다. 화면 배율(DPI × 확대)은 그릴 때 렌더 타깃의 DPI 로 반영한다.
//!
//! 글 하나(`Item::Text`)가 선택 · 찾기 · 링크의 단위다. 그 글의 UTF-16 원문과 링크 구간을 `TextMeta` 로 같이 든다.

use std::cell::Cell;
use std::path::PathBuf;
use std::sync::Arc;

use windows::core::{w, Interface, BOOL, PCWSTR};
use windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush;
use windows::Win32::Graphics::DirectWrite::*;

use super::hl::{self, Tok};
use super::img;
use super::md::{Align, Block, Doc, Inline, Item as ListItem};

// ── 색 ────────────────────────────────────────────────────────────────────

pub type Rgba = [f32; 4];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(usize)]
pub enum Col {
    Bg = 0,
    Fg,
    Muted,
    Link,
    Border,
    CodeBlock,
    CodeInline,
    QuoteBar,
    // 코드 색(highlight.js github 테마)
    TKeyword,
    TTitle,
    TAttr,
    TString,
    TBuiltin,
    TComment,
    TName,
    TSection,
    TBullet,
    // 글자 고르기 · 찾기 · 스크롤바
    Sel,
    Hit,
    HitCur,
    HitOutline,
    Thumb,
    ThumbHover,
    // 메뉴(base.css 의 --accent · --accent-fg, 그림자 색)
    Accent,
    AccentFg,
    Shadow,
}
pub const COLS: usize = 26;

fn hex(c: u32) -> Rgba {
    [
        ((c >> 16) & 255) as f32 / 255.0,
        ((c >> 8) & 255) as f32 / 255.0,
        (c & 255) as f32 / 255.0,
        1.0,
    ]
}

fn rgba(c: u32, a: f32) -> Rgba {
    let mut v = hex(c);
    v[3] = a;
    v
}

/// markdown.css · hljs.css 의 `--md-*` 변수와 같은 값(밝은 테마 · 어두운 테마).
pub fn palette(dark: bool) -> [Rgba; COLS] {
    if dark {
        [
            hex(0x16181c),
            hex(0xd6d9de),
            hex(0x9aa0a9),
            hex(0x6fb3f2),
            hex(0x2c3037),
            hex(0x1b1e24),
            hex(0x22262d),
            hex(0x3a404a),
            hex(0xff7b72),
            hex(0xd2a8ff),
            hex(0x79c0ff),
            hex(0xa5d6ff),
            hex(0xffa657),
            hex(0x8b949e),
            hex(0x7ee787),
            hex(0x1f6feb),
            hex(0xf2cc60),
            rgba(0x3c8cff, 0.42),
            hex(0x6b5300),
            hex(0xb98d00),
            hex(0xffd75e),
            hex(0x2c3037),
            hex(0x3a404a),
            hex(0xe6e9ee),
            hex(0x16181c),
            rgba(0x000000, 0.55),
        ]
    } else {
        [
            hex(0xfbfbf9),
            hex(0x22252a),
            hex(0x5c626b),
            hex(0x0b62c4),
            hex(0xe3e4e0),
            hex(0xf6f6f3),
            hex(0xf0f0ec),
            hex(0xc9cbc5),
            hex(0xcf222e),
            hex(0x8250df),
            hex(0x0550ae),
            hex(0x0a3069),
            hex(0x953800),
            hex(0x69707a),
            hex(0x116329),
            hex(0x0550ae),
            hex(0x7d4e00),
            rgba(0x0078d7, 0.30),
            hex(0xffe89a),
            hex(0xffc94d),
            hex(0xb8860b),
            hex(0xe3e4e0),
            hex(0xc9cbc5),
            hex(0x1f2229),
            hex(0xfbfbf9),
            rgba(0x000000, 0.16),
        ]
    }
}

fn tok_col(t: Tok) -> Col {
    match t {
        Tok::Keyword => Col::TKeyword,
        Tok::Title => Col::TTitle,
        Tok::Attr => Col::TAttr,
        Tok::Str => Col::TString,
        Tok::Builtin => Col::TBuiltin,
        Tok::Comment => Col::TComment,
        Tok::Name => Col::TName,
        Tok::Section => Col::TSection,
        Tok::Bullet => Col::TBullet,
    }
}

pub struct Brushes {
    pub b: Vec<ID2D1SolidColorBrush>,
}

// ── 그릴 것 ────────────────────────────────────────────────────────────────

/// 글을 복사할 때 이 글 뒤에 붙는 구분
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sep {
    None,
    Tab,
    Line,
    Para,
}

impl Sep {
    pub fn text(self) -> &'static str {
        match self {
            Sep::None => "",
            Sep::Tab => "\t",
            Sep::Line => "\n",
            Sep::Para => "\n\n",
        }
    }
}

/// 글 안의 링크 한 구간(UTF-16)
#[derive(Clone, Debug)]
pub struct LinkSpan {
    pub start: u32,
    pub end: u32,
    pub href: Arc<str>,
}

/// 고르기 · 찾기 · 링크가 쓰는 글의 정보. 목록 기호 같은 장식 글에는 없다.
pub struct TextMeta {
    /// DirectWrite 글(어절을 끊지 않으려고 끼운 U+2060 도 들어 있다)
    pub text: Vec<u16>,
    pub links: Vec<LinkSpan>,
    pub sep: Sep,
    /// 읽는 순서의 번호(고른 자리가 다시 놓은 뒤에도 같은 글을 가리키게 한다)
    pub ord: u32,
    /// 코드 상자의 가로 스크롤(CSS px)
    pub hscroll: Cell<f32>,
    /// 글 상자의 너비(코드 상자가 얼마나 스크롤될 수 있는지)
    pub content_w: f32,
}

pub struct ImageItem {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub path: Arc<PathBuf>,
    /// 그림을 누르면 가는 곳(`[![](그림)](주소)`)
    pub href: Option<Arc<str>>,
}

pub enum Item {
    Text {
        layout: IDWriteTextLayout,
        x: f32,
        y: f32,
        h: f32,
        clip: Option<[f32; 4]>,
        meta: Option<Box<TextMeta>>,
    },
    Fill {
        r: [f32; 4],
        col: Col,
        radius: f32,
    },
    Stroke {
        r: [f32; 4],
        col: Col,
        width: f32,
        radius: f32,
    },
    Line {
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        col: Col,
        width: f32,
    },
    Check {
        x: f32,
        y: f32,
        size: f32,
        checked: bool,
    },
    Image(ImageItem),
}

/// 눌러서 뭔가 일어나는 자리(글이 아닌 것)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hot {
    /// 앞머리(front matter) 접기 · 펴기
    FrontMatter,
}

pub struct Layout {
    pub items: Vec<Item>,
    pub height: f32,
    /// 최상위 블록의 눈에 보이는 위·아래(디버그 비교용: 렌더러의 실제 위치와 맞대 본다)
    pub boxes: Vec<(&'static str, f32, f32)>,
    /// 문서 안 이동 자리: (id, 그 블록의 위 y). 제목 · 각주.
    pub anchors: Vec<(Arc<str>, f32)>,
    pub hots: Vec<(Hot, [f32; 4])>,
    /// 읽는 순서 번호 → items 의 자리
    pub sel: Vec<u32>,
    /// 최상위 블록마다 위 y(블록 번호 → y). 크기가 바뀌어 다시 놓은 뒤에도 읽던 블록에 머무르려는 것이다.
    pub block_tops: Vec<f32>,
}

impl Layout {
    pub fn empty() -> Layout {
        Layout {
            items: Vec::new(),
            height: 0.0,
            boxes: Vec::new(),
            anchors: Vec::new(),
            hots: Vec::new(),
            sel: Vec::new(),
            block_tops: Vec::new(),
        }
    }
}

// ── 글꼴 ───────────────────────────────────────────────────────────────────

pub struct Gfx {
    pub dw: IDWriteFactory,
    fallback: Option<IDWriteFontFallback>,
    body_family: &'static str,
    mono_family: &'static str,
    /// 아이콘 글꼴(Windows 11: Segoe Fluent Icons · Windows 10: Segoe MDL2 Assets). 없으면 None.
    icon_family: Option<&'static str>,
    /// (ascent, descent) 를 em 으로. 줄 안에서 글자를 세로 가운데로 놓는 데 쓴다.
    body_metrics: (f32, f32),
    mono_metrics: (f32, f32),
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn find_family(dw: &IDWriteFactory, name: &str) -> Option<(IDWriteFontCollection, u32)> {
    unsafe {
        let mut col: Option<IDWriteFontCollection> = None;
        dw.GetSystemFontCollection(&mut col, false).ok()?;
        let col = col?;
        let n = wide(name);
        let (mut idx, mut exists) = (0u32, BOOL(0));
        col.FindFamilyName(PCWSTR(n.as_ptr()), &mut idx, &mut exists)
            .ok()?;
        if exists.as_bool() {
            Some((col, idx))
        } else {
            None
        }
    }
}

fn metrics_of(dw: &IDWriteFactory, name: &str) -> (f32, f32) {
    let fallback = (1.079, 0.251);
    unsafe {
        let Some((col, idx)) = find_family(dw, name) else {
            return fallback;
        };
        let Ok(fam) = col.GetFontFamily(idx) else {
            return fallback;
        };
        let Ok(font) = fam.GetFirstMatchingFont(
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
        ) else {
            return fallback;
        };
        let mut m = DWRITE_FONT_METRICS::default();
        font.GetMetrics(&mut m);
        let upm = m.designUnitsPerEm as f32;
        if upm <= 0.0 {
            return fallback;
        }
        (m.ascent as f32 / upm, m.descent as f32 / upm)
    }
}

impl Gfx {
    pub fn new(dw: IDWriteFactory) -> Gfx {
        let has_noto = find_family(&dw, "Noto Sans KR").is_some();
        let fallback = build_fallback(&dw, has_noto);
        // markdown.css 의 --md-font-code 순서: Roboto Mono → DejaVu Sans Mono → Consolas (앞의 둘은 깔려 있으면 쓰인다)
        let mono_family = ["Roboto Mono", "DejaVu Sans Mono", "Consolas"]
            .into_iter()
            .find(|n| find_family(&dw, n).is_some())
            .unwrap_or("Consolas");
        let body_metrics = metrics_of(&dw, "Segoe UI");
        let mono_metrics = metrics_of(&dw, mono_family);
        let icon_family = ["Segoe Fluent Icons", "Segoe MDL2 Assets"]
            .into_iter()
            .find(|n| find_family(&dw, n).is_some());
        Gfx {
            dw,
            fallback,
            body_family: "Segoe UI",
            mono_family,
            icon_family,
            body_metrics,
            mono_metrics,
        }
    }

    /// 글꼴 파일을 미리 읽어 둔다. 첫 배치가 글꼴을 처음 만나 느려지는 값(수십 ms)을 다른 스레드에서 미리 치러 두려는 것이다
    /// (DirectWrite 의 글꼴 캐시는 프로세스 전체가 나눠 쓴다).
    pub fn warm(&self) {
        let text: Vec<u16> = "가나다라 한글 Abc xyz 0123 —•".encode_utf16().collect();
        for (family, bold) in [
            (self.body_family, false),
            (self.body_family, true),
            (self.mono_family, false),
        ] {
            let fam = wide(family);
            unsafe {
                let Ok(fmt) = self.dw.CreateTextFormat(
                    PCWSTR(fam.as_ptr()),
                    None,
                    if bold {
                        DWRITE_FONT_WEIGHT_BOLD
                    } else {
                        DWRITE_FONT_WEIGHT_NORMAL
                    },
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    17.0,
                    w!("ko-KR"),
                ) else {
                    continue;
                };
                if let Some(fb) = &self.fallback {
                    if let Ok(f1) = fmt.cast::<IDWriteTextFormat1>() {
                        let _ = f1.SetFontFallback(fb);
                    }
                }
                if let Ok(layout) = self.dw.CreateTextLayout(&text, &fmt, 400.0, 100.0) {
                    let mut m = DWRITE_TEXT_METRICS::default();
                    let _ = layout.GetMetrics(&mut m);
                }
            }
        }
    }

    /// 아이콘 글리프 하나(PUA 문자). 아이콘 글꼴이 없으면 None.
    pub fn icon_layout(&self, glyph: char, size: f32) -> Option<IDWriteTextLayout> {
        let fam = wide(self.icon_family?);
        let t: Vec<u16> = glyph.to_string().encode_utf16().collect();
        unsafe {
            let fmt = self
                .dw
                .CreateTextFormat(
                    PCWSTR(fam.as_ptr()),
                    None,
                    DWRITE_FONT_WEIGHT_NORMAL,
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    size,
                    w!("en-US"),
                )
                .ok()?;
            let l = self
                .dw
                .CreateTextLayout(&t, &fmt, size * 2.0, size * 2.0)
                .ok()?;
            let _ = l.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
            Some(l)
        }
    }

    /// UI 글(찾기 막대 · 목차 · 컨트롤)용 한 줄 글. 본문과 같은 글꼴 · 한글 폴백을 쓴다.
    pub fn ui_layout(
        &self,
        text: &str,
        size: f32,
        bold: bool,
        max_w: f32,
        max_h: f32,
    ) -> Option<IDWriteTextLayout> {
        let t: Vec<u16> = text.encode_utf16().collect();
        let fam = wide(self.body_family);
        unsafe {
            let fmt = self
                .dw
                .CreateTextFormat(
                    PCWSTR(fam.as_ptr()),
                    None,
                    if bold {
                        DWRITE_FONT_WEIGHT_SEMI_BOLD
                    } else {
                        DWRITE_FONT_WEIGHT_NORMAL
                    },
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    size,
                    w!("ko-KR"),
                )
                .ok()?;
            if let Some(fb) = &self.fallback {
                if let Ok(f1) = fmt.cast::<IDWriteTextFormat1>() {
                    let _ = f1.SetFontFallback(fb);
                }
            }
            let l = self.dw.CreateTextLayout(&t, &fmt, max_w, max_h).ok()?;
            let _ = l.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
            Some(l)
        }
    }
}

/// 한글은 렌더러와 같이 Noto Sans KR(있으면) → 시스템 순으로.
fn build_fallback(dw: &IDWriteFactory, has_noto: bool) -> Option<IDWriteFontFallback> {
    unsafe {
        let dw2: IDWriteFactory2 = dw.cast().ok()?;
        let b = dw2.CreateFontFallbackBuilder().ok()?;
        if has_noto {
            let ranges = [
                DWRITE_UNICODE_RANGE {
                    first: 0x1100,
                    last: 0x11ff,
                },
                DWRITE_UNICODE_RANGE {
                    first: 0x3130,
                    last: 0x318f,
                },
                DWRITE_UNICODE_RANGE {
                    first: 0xa960,
                    last: 0xa97f,
                },
                DWRITE_UNICODE_RANGE {
                    first: 0xac00,
                    last: 0xd7ff,
                },
            ];
            let fam = wide("Noto Sans KR");
            let fams = [fam.as_ptr()];
            b.AddMapping(&ranges, &fams, None, PCWSTR::null(), PCWSTR::null(), 1.0)
                .ok()?;
        }
        let sys = dw2.GetSystemFontFallback().ok()?;
        b.AddMappings(&sys).ok()?;
        b.CreateFontFallback().ok()
    }
}

// ── 인라인 → 글 ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
struct RunStyle {
    bold: bool,
    italic: bool,
    strike: bool,
    underline: bool,
    mono: bool,
    /// 글자 크기 배율(코드 0.88 · 각주 번호 0.83). 0 이면 1.
    scale: f32,
    color: Option<Col>,
    /// 인라인 코드 배경
    bg: bool,
}

struct Run {
    start: u32,
    len: u32,
    st: RunStyle,
}

struct Flat {
    text: Vec<u16>,
    runs: Vec<Run>,
    links: Vec<LinkSpan>,
    /// 마지막으로 넣은 글자(한글 어절을 끊지 않으려고 WJ 를 끼우는 데 쓴다)
    last: Option<char>,
    /// 한글이 낀 어절을 중간에서 끊지 않는다(word-break: keep-all). 코드 · 원문에서는 끈다.
    keep_all: bool,
}

impl Default for Flat {
    fn default() -> Flat {
        Flat {
            text: Vec::new(),
            runs: Vec::new(),
            links: Vec::new(),
            last: None,
            keep_all: true,
        }
    }
}

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11ff | 0x3130..=0x318f | 0xa960..=0xa97f | 0xac00..=0xd7ff)
}

/// 어절 끝에 붙는 문장부호는 앞 글자와 떨어지지 않는다(줄바꿈 규칙이 이미 막는다).
fn is_closer(c: char) -> bool {
    matches!(
        c,
        '.' | ',' | '!' | '?' | ':' | ';' | ')' | ']' | '}' | '、' | '。' | '”' | '’'
    )
}

impl Flat {
    fn push_str(&mut self, s: &str, st: RunStyle) {
        let start = self.text.len() as u32;
        for c in s.chars() {
            // word-break: keep-all — 한글이 낀 어절은 중간에서 줄을 바꾸지 않는다.
            // (U+2060 WORD JOINER 는 보이지 않고, 그 앞뒤에서의 줄바꿈을 막는다.)
            if self.keep_all {
                if let Some(p) = self.last {
                    let word = |x: char| !x.is_whitespace() && x != '\u{2060}';
                    if word(p) && word(c) && (is_hangul(p) || is_hangul(c)) && !is_closer(c) {
                        self.text.push(0x2060);
                    }
                }
            }
            let mut buf = [0u16; 2];
            self.text.extend_from_slice(c.encode_utf16(&mut buf));
            self.last = Some(c);
        }
        let len = self.text.len() as u32 - start;
        if len > 0 {
            self.runs.push(Run { start, len, st });
        }
    }

    fn inlines(&mut self, inl: &[Inline], st: RunStyle) {
        for i in inl {
            match i {
                Inline::Text(t) => self.push_str(t, st),
                Inline::Code(c) => self.push_str(
                    c,
                    RunStyle {
                        mono: true,
                        scale: 0.88,
                        bg: true,
                        ..st
                    },
                ),
                Inline::Math(m) | Inline::DisplayMath(m) => self.push_str(
                    m,
                    RunStyle {
                        italic: true,
                        color: Some(Col::Muted),
                        ..st
                    },
                ),
                Inline::Strong(c) => self.inlines(c, RunStyle { bold: true, ..st }),
                Inline::Em(c) => self.inlines(c, RunStyle { italic: true, ..st }),
                Inline::Strike(c) => self.inlines(c, RunStyle { strike: true, ..st }),
                Inline::Link { href, children } => {
                    let start = self.text.len() as u32;
                    self.inlines(
                        children,
                        RunStyle {
                            underline: true,
                            color: Some(Col::Link),
                            ..st
                        },
                    );
                    let end = self.text.len() as u32;
                    if end > start {
                        self.links.push(LinkSpan {
                            start,
                            end,
                            href: href.clone(),
                        });
                    }
                }
                Inline::Image { alt, .. } => {
                    let s = if alt.is_empty() {
                        "그림".to_string()
                    } else {
                        format!("그림: {alt}")
                    };
                    self.push_str(
                        &format!("[{s}]"),
                        RunStyle {
                            italic: true,
                            color: Some(Col::Muted),
                            ..st
                        },
                    )
                }
                Inline::FootnoteRef(n) => {
                    let start = self.text.len() as u32;
                    self.push_str(
                        &format!("[{n}]"),
                        RunStyle {
                            scale: 0.83,
                            color: Some(Col::Link),
                            ..st
                        },
                    );
                    self.links.push(LinkSpan {
                        start,
                        end: self.text.len() as u32,
                        href: format!("#fn{n}").into(),
                    });
                }
                Inline::Break => {
                    self.text.push(b'\n' as u16);
                    self.last = Some('\n');
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct TextStyle {
    size: f32,
    /// 줄 높이 배율
    lh: f32,
    bold: bool,
    italic: bool,
    mono: bool,
    /// None 이면 지금 문맥의 기본 글자색(본문 Fg · 인용 안 Muted)
    color: Option<Col>,
    align: DWRITE_TEXT_ALIGNMENT,
    nowrap: bool,
}

impl TextStyle {
    fn body(size: f32) -> TextStyle {
        TextStyle {
            size,
            lh: 1.75,
            bold: false,
            italic: false,
            mono: false,
            color: None,
            align: DWRITE_TEXT_ALIGNMENT_LEADING,
            nowrap: false,
        }
    }
}

struct Built {
    layout: IDWriteTextLayout,
    w: f32,
    h: f32,
    /// 인라인 코드 배경 상자(글 상자 안 좌표)
    bgs: Vec<[f32; 4]>,
    text: Vec<u16>,
    links: Vec<LinkSpan>,
}

// ── 배치 ───────────────────────────────────────────────────────────────────

const FONT: f32 = 17.0;
/// 렌더러의 디스플레이 수식(분수가 든 것) 한 블록의 높이
const MATH_BLOCK_H: f32 = 56.3;
/// 위첨자(각주 번호)가 든 줄이 더 높아지는 만큼
const SUP_LIFT: f32 = 2.3;
/// 코드 상자의 가로 스크롤바 두께
const CODE_SCROLLBAR: f32 = 10.0;
/// 줄 상자 안에서 그림 아래에 남는 자리(글줄의 descent + 반 줄간격 — 실측)
const IMG_DESCENT: f32 = 7.84;
/// 표 글자를 줄이는 하한(src/markdown/fit-width.ts FLOOR)
const FIT_FLOOR: f32 = 0.55;
/// 원문 보기에서 글 한 덩어리의 줄 수(한 덩어리가 너무 크면 배치가 오래 걸린다)
const PLAIN_LINES: usize = 120;

fn has_inline_math(inl: &[Inline]) -> bool {
    inl.iter().any(|i| match i {
        Inline::Math(_) => true,
        Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => has_inline_math(c),
        Inline::Link { children, .. } => has_inline_math(children),
        _ => false,
    })
}

fn max_footnote_ref(inl: &[Inline]) -> usize {
    inl.iter()
        .map(|i| match i {
            Inline::FootnoteRef(n) => *n,
            Inline::Strong(c) | Inline::Em(c) | Inline::Strike(c) => max_footnote_ref(c),
            Inline::Link { children, .. } => max_footnote_ref(children),
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

/// 문단 안의 그림 하나: (주소, 대체 글, 그림을 감싼 링크 주소)
type ImgRef = (Arc<str>, String, Option<Arc<str>>);

/// 문단이 그림만으로 이루어졌는가(공백 · 줄바꿈은 무시). 그림 하나하나와 그것을 감싼 링크 주소.
fn image_only(inl: &[Inline]) -> Option<Vec<ImgRef>> {
    let mut out = Vec::new();
    for i in inl {
        match i {
            Inline::Image { src, alt } => out.push((src.clone(), alt.clone(), None)),
            Inline::Link { href, children } => {
                for c in children {
                    match c {
                        Inline::Image { src, alt } => {
                            out.push((src.clone(), alt.clone(), Some(href.clone())))
                        }
                        Inline::Text(t) if t.trim().is_empty() => {}
                        Inline::Break => {}
                        _ => return None,
                    }
                }
            }
            Inline::Text(t) if t.trim().is_empty() => {}
            Inline::Break => {}
            _ => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

enum ImgInfo {
    Local { w: u32, h: u32, path: PathBuf },
    Remote,
    Missing,
}

/// 배치에 필요한 문서 밖의 사정
pub struct Ctx {
    /// 문서가 있는 폴더(상대 그림 주소의 기준)
    pub dir: Option<PathBuf>,
    /// 앞머리(front matter)를 펴 놓았는가
    pub fm_open: bool,
    /// 원격 그림을 불러오는가(설정). 끄면 자리표시자를 그린다.
    pub remote_images: bool,
    pub korean: bool,
}

impl Ctx {
    #[cfg(test)]
    pub fn plain() -> Ctx {
        Ctx {
            dir: None,
            fm_open: false,
            remote_images: false,
            korean: true,
        }
    }
}

pub struct Layouter<'a> {
    gfx: &'a Gfx,
    br: &'a Brushes,
    ctx: &'a Ctx,
    /// 가는 선 두께: 화면 픽셀 1칸(CSS px 로)
    hair: f32,
    items: Vec<Item>,
    boxes: Vec<(&'static str, f32, f32)>,
    anchors: Vec<(Arc<str>, f32)>,
    hots: Vec<(Hot, [f32; 4])>,
    block_tops: Vec<f32>,
    /// 세로 커서. pending 은 아래쪽 여백 — 다음 블록의 위쪽 여백과 겹쳐서 큰 쪽만 쓴다(CSS 의 margin collapse).
    y: f32,
    pending: f32,
    /// 기본 글자색
    base: Col,
    /// 다음에 줄 읽는 순서 번호
    ord: u32,
    /// 지금까지 본 가장 큰 각주 번호(각주로 돌아오는 자리를 처음 참조한 곳으로 잡는다)
    fnref: usize,
}

/// 문서를 조금씩 이어 놓기 위한 자리: 다음에 놓을 블록 · 세로 커서 · 아래 여백(다음 블록의 위 여백과 겹치는 것).
/// ★ 처음 화면에 필요한 만큼만 먼저 놓고 나머지는 틈틈이 이어 놓는다 — 큰 문서를 통째로 놓느라 첫 글이 늦어지지 않게.
#[derive(Clone, Copy, Default)]
pub struct Progress {
    pub next: usize,
    pub y: f32,
    pub pending: f32,
    pub footnotes: bool,
    pub ord: u32,
    pub fnref: usize,
}

impl Progress {
    pub fn done(&self, doc: &Doc) -> bool {
        self.next >= doc.blocks.len() && (self.footnotes || doc.footnotes.is_empty())
    }
}

impl<'a> Layouter<'a> {
    /// 앞에서 멈춘 자리(p)에서 이어 놓을 배치기. 놓은 것(items)은 이번에 놓은 만큼만 담긴다.
    pub fn resume(
        gfx: &'a Gfx,
        br: &'a Brushes,
        ctx: &'a Ctx,
        hair: f32,
        p: &Progress,
    ) -> Layouter<'a> {
        Layouter {
            gfx,
            br,
            ctx,
            hair,
            items: Vec::new(),
            boxes: Vec::new(),
            anchors: Vec::new(),
            hots: Vec::new(),
            block_tops: Vec::new(),
            y: p.y,
            pending: p.pending,
            base: Col::Fg,
            ord: p.ord,
            fnref: p.fnref,
        }
    }

    pub fn finish(self) -> Layout {
        Layout {
            items: self.items,
            height: self.y + self.pending,
            boxes: self.boxes,
            anchors: self.anchors,
            hots: self.hots,
            sel: Vec::new(),
            block_tops: self.block_tops,
        }
    }

    /// doc 를 p 에서 이어 놓는다. 세로 커서가 until_y 에 닿거나 deadline 이 지나면 멈춘다(블록 하나는 쪼개지 않는다).
    pub fn advance(
        &mut self,
        doc: &Doc,
        p: &mut Progress,
        x: f32,
        w: f32,
        until_y: f32,
        deadline: Option<std::time::Instant>,
    ) {
        while p.next < doc.blocks.len() {
            if self.y + self.pending >= until_y {
                break;
            }
            if deadline
                .map(|d| std::time::Instant::now() >= d)
                .unwrap_or(false)
            {
                break;
            }
            self.top_block(&doc.blocks[p.next], x, w, p.next == 0);
            p.next += 1;
        }
        if p.next >= doc.blocks.len() && !p.footnotes {
            if !doc.footnotes.is_empty() {
                self.footnotes(&doc.footnotes, x, w);
            }
            p.footnotes = true;
        }
        p.y = self.y;
        p.pending = self.pending;
        p.ord = self.ord;
        p.fnref = self.fnref;
    }

    /// 다음 블록을 놓을 y. 위쪽 여백은 앞 블록의 아래 여백과 겹친다.
    fn open(&mut self, mt: f32) -> f32 {
        self.y += self.pending.max(mt);
        self.pending = 0.0;
        self.y
    }
    fn close(&mut self, h: f32, mb: f32) {
        self.y += h;
        self.pending = mb;
    }

    fn brush(&self, c: Col) -> windows::core::IUnknown {
        self.br.b[c as usize].cast().expect("brush")
    }

    fn build(&self, inl: &[Inline], st: &TextStyle, max_w: f32) -> Option<Built> {
        let mut flat = Flat::default();
        flat.inlines(
            inl,
            RunStyle {
                bold: st.bold,
                italic: st.italic,
                mono: st.mono,
                ..Default::default()
            },
        );
        // 끝의 줄바꿈은 빈 줄을 만든다
        while flat.text.last() == Some(&(b'\n' as u16)) {
            flat.text.pop();
        }
        if flat.text.is_empty() {
            return None;
        }
        self.build_flat(flat, st, max_w, &[])
    }

    fn build_flat(
        &self,
        flat: Flat,
        st: &TextStyle,
        max_w: f32,
        spans: &[hl::Span],
    ) -> Option<Built> {
        unsafe {
            let family = if st.mono {
                self.gfx.mono_family
            } else {
                self.gfx.body_family
            };
            let fam = wide(family);
            let fmt = self
                .gfx
                .dw
                .CreateTextFormat(
                    PCWSTR(fam.as_ptr()),
                    None,
                    if st.bold {
                        DWRITE_FONT_WEIGHT_BOLD
                    } else {
                        DWRITE_FONT_WEIGHT_NORMAL
                    },
                    if st.italic {
                        DWRITE_FONT_STYLE_ITALIC
                    } else {
                        DWRITE_FONT_STYLE_NORMAL
                    },
                    DWRITE_FONT_STRETCH_NORMAL,
                    st.size,
                    w!("ko-KR"),
                )
                .ok()?;
            if let Some(fb) = &self.gfx.fallback {
                if let Ok(f1) = fmt.cast::<IDWriteTextFormat1>() {
                    let _ = f1.SetFontFallback(fb);
                }
            }
            let layout = self
                .gfx
                .dw
                .CreateTextLayout(&flat.text, &fmt, max_w.max(1.0), 1.0e6)
                .ok()?;

            let lh = st.size * st.lh;
            let (asc, desc) = if st.mono {
                self.gfx.mono_metrics
            } else {
                self.gfx.body_metrics
            };
            let baseline = ((lh - (asc + desc) * st.size) / 2.0 + asc * st.size).max(0.0);
            let _ = layout.SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, lh, baseline);
            let _ = layout.SetTextAlignment(st.align);
            // overflow-wrap: break-word — 어절 하나가 줄보다 길면 그때만 글자 사이에서 끊는다.
            let _ = layout.SetWordWrapping(if st.nowrap {
                DWRITE_WORD_WRAPPING_NO_WRAP
            } else {
                DWRITE_WORD_WRAPPING_EMERGENCY_BREAK
            });
            let base_brush = self.brush(st.color.unwrap_or(self.base));
            let all = DWRITE_TEXT_RANGE {
                startPosition: 0,
                length: flat.text.len() as u32,
            };
            let _ = layout.SetDrawingEffect(&base_brush, all);

            let mut bgs = Vec::new();
            for r in &flat.runs {
                let range = DWRITE_TEXT_RANGE {
                    startPosition: r.start,
                    length: r.len,
                };
                let s = r.st;
                if s.bold && !st.bold {
                    let _ = layout.SetFontWeight(DWRITE_FONT_WEIGHT_BOLD, range);
                }
                if s.italic && !st.italic {
                    let _ = layout.SetFontStyle(DWRITE_FONT_STYLE_ITALIC, range);
                }
                if s.strike {
                    let _ = layout.SetStrikethrough(true, range);
                }
                if s.underline {
                    let _ = layout.SetUnderline(true, range);
                }
                if s.mono && !st.mono {
                    let m = wide(self.gfx.mono_family);
                    let _ = layout.SetFontFamilyName(PCWSTR(m.as_ptr()), range);
                }
                if s.scale != 0.0 && s.scale != 1.0 {
                    let _ = layout.SetFontSize(st.size * s.scale, range);
                }
                if let Some(c) = s.color {
                    let _ = layout.SetDrawingEffect(&self.brush(c), range);
                }
                if s.bg {
                    let mut count = 0u32;
                    let _ = layout.HitTestTextRange(r.start, r.len, 0.0, 0.0, None, &mut count);
                    if count > 0 {
                        let mut ms = vec![DWRITE_HIT_TEST_METRICS::default(); count as usize];
                        let _ = layout.HitTestTextRange(
                            r.start,
                            r.len,
                            0.0,
                            0.0,
                            Some(&mut ms),
                            &mut count,
                        );
                        for m in ms.iter().take(count as usize) {
                            // 줄 높이 전체가 아니라 글자 높이만큼만 칠한다.
                            let pad = (lh - st.size * 1.25) / 2.0;
                            let side = 0.34 * st.size * 0.88;
                            bgs.push([
                                m.left - side,
                                m.top + pad,
                                m.left + m.width + side,
                                m.top + m.height - pad,
                            ]);
                        }
                    }
                }
            }
            // 코드 색
            for sp in spans {
                let range = DWRITE_TEXT_RANGE {
                    startPosition: sp.start,
                    length: sp.end - sp.start,
                };
                let _ = layout.SetDrawingEffect(&self.brush(tok_col(sp.tok)), range);
                if sp.tok == Tok::Section {
                    let _ = layout.SetFontWeight(DWRITE_FONT_WEIGHT_BOLD, range);
                }
            }

            let mut tm = DWRITE_TEXT_METRICS::default();
            layout.GetMetrics(&mut tm).ok()?;
            Some(Built {
                layout,
                w: tm.widthIncludingTrailingWhitespace,
                h: tm.height,
                bgs,
                text: flat.text,
                links: flat.links,
            })
        }
    }

    /// 놓은 글을 목록에 올린다. sel 이 있으면 고르기 · 찾기 · 링크의 대상이 된다(구분은 복사할 때 뒤에 붙는 것).
    fn push_text(&mut self, b: Built, x: f32, y: f32, clip: Option<[f32; 4]>, sel: Option<Sep>) {
        for r in &b.bgs {
            self.items.push(Item::Fill {
                r: [x + r[0], y + r[1], x + r[2], y + r[3]],
                col: Col::CodeInline,
                radius: 4.0,
            });
        }
        let meta = sel.map(|sep| {
            let ord = self.ord;
            self.ord += 1;
            Box::new(TextMeta {
                text: b.text,
                links: b.links,
                sep,
                ord,
                hscroll: Cell::new(0.0),
                content_w: b.w,
            })
        });
        self.items.push(Item::Text {
            layout: b.layout,
            x,
            y,
            h: b.h,
            clip,
            meta,
        });
    }

    // ── 블록 ───────────────────────────────────────────────────────────────

    fn blocks(&mut self, blocks: &[Block], x: f32, w: f32, first_is_flush: bool) {
        for (i, b) in blocks.iter().enumerate() {
            self.block(b, x, w, first_is_flush && i == 0);
        }
    }

    /// 최상위 블록 하나를 놓고, 그 블록이 차지한 눈에 보이는 위·아래를 기록한다.
    fn top_block(&mut self, b: &Block, x: f32, w: f32, flush: bool) {
        let before = self.items.len();
        self.block(b, x, w, flush);
        let (mut top, mut bottom) = (f32::MAX, f32::MIN);
        for it in &self.items[before..] {
            let (t, bt) = match it {
                Item::Text { y, h, .. } => (*y, *y + *h),
                Item::Fill { r, .. } | Item::Stroke { r, .. } => (r[1], r[3]),
                Item::Line { y1, y2, .. } => (y1.min(*y2), y1.max(*y2)),
                Item::Check { y, size, .. } => (*y, *y + *size),
                Item::Image(i) => (i.y, i.y + i.h),
            };
            top = top.min(t);
            bottom = bottom.max(bt);
        }
        // 블록이 아무것도 안 그렸어도 번호는 맞춘다(그 자리의 y)
        self.block_tops
            .push(if top <= bottom { top } else { self.y });
        if top <= bottom {
            let kind = match b {
                Block::Heading { .. } => "heading",
                Block::Paragraph(_) | Block::Tight(_) | Block::Piece(_) | Block::Group(_) => "p",
                Block::Code { .. } => "code",
                Block::Math(_) => "math",
                Block::Quote(_) => "quote",
                Block::List { .. } => "list",
                Block::Table { .. } => "table",
                Block::Rule => "hr",
                Block::FrontMatter(_) => "front",
                Block::Plain(_) => "plain",
            };
            self.boxes.push((kind, top, bottom));
        }
    }

    fn block(&mut self, b: &Block, x: f32, w: f32, flush: bool) {
        match b {
            Block::Heading { level, inl, id } => {
                let scale = match level {
                    1 => 1.7,
                    2 => 1.4,
                    3 => 1.2,
                    4 => 1.05,
                    _ => 1.0,
                };
                let size = FONT * scale;
                let st = TextStyle {
                    lh: 1.35,
                    bold: true,
                    // h5 · h6 은 흐린 글자색
                    color: if *level >= 5 { Some(Col::Muted) } else { None },
                    ..TextStyle::body(size)
                };
                let mt = if flush { 0.0 } else { 1.8 * size };
                if let Some(t) = self.build(inl, &st, w) {
                    let y = self.open(mt);
                    let h = t.h;
                    if !id.is_empty() {
                        self.anchors.push((id.clone(), y));
                    }
                    self.push_text(t, x, y, None, Some(Sep::Para));
                    self.close(h, 0.6 * size);
                }
            }
            Block::Paragraph(inl) => self.paragraph(inl, x, w, 0.9 * FONT, Sep::Para),
            Block::Tight(inl) => self.paragraph(inl, x, w, 0.0, Sep::Line),
            // 긴 문단의 앞 조각: 여백도 구분도 없이 다음 조각으로 이어진다
            Block::Piece(inl) => self.paragraph(inl, x, w, 0.0, Sep::None),
            Block::Group(blocks) => self.blocks(blocks, x, w, flush),
            Block::Code { lang, text } => self.code(lang, text, x, w),
            Block::Math(m) => {
                let st = TextStyle {
                    align: DWRITE_TEXT_ALIGNMENT_CENTER,
                    italic: true,
                    color: Some(Col::Muted),
                    ..TextStyle::body(FONT)
                };
                if let Some(t) = self.build(&[Inline::Text(m.clone())], &st, w) {
                    let y = self.open(FONT);
                    // 렌더러의 분수가 든 디스플레이 수식 높이(실측 56.3). 수식은 그리지 못하니 그만한 자리에 원문을 가운데 놓는다.
                    let h = MATH_BLOCK_H.max(t.h + 4.0);
                    let ty = y + (h - t.h) / 2.0;
                    self.push_text(t, x, ty, None, None);
                    self.close(h, FONT);
                }
            }
            Block::Quote(children) => {
                let bar = 2.667;
                let pad_l = 14.0;
                let pad_v = 0.1 * FONT;
                let y0 = self.open(0.0);
                self.y = y0 + pad_v;
                self.pending = 0.0;
                let start = self.items.len();
                let prev = self.base;
                self.base = Col::Muted;
                self.blocks(children, x + bar + pad_l, w - bar - pad_l, false);
                self.base = prev;
                // 마지막 자식의 아래 여백은 인용의 패딩 안에 갇힌다.
                let end = self.y + self.pending + pad_v;
                self.y = end;
                self.pending = 1.1 * FONT;
                // 막대는 글 아래에 깔린다
                self.items.insert(
                    start,
                    Item::Fill {
                        r: [x, y0, x + bar, end],
                        col: Col::QuoteBar,
                        radius: 0.0,
                    },
                );
            }
            Block::List {
                ordered,
                start,
                items,
            } => self.list(*ordered, *start, items, x, w),
            Block::Table { aligns, head, rows } => self.table(aligns, head, rows, x, w),
            Block::Rule => {
                let y = self.open(2.0 * FONT);
                self.items.push(Item::Line {
                    x1: x,
                    y1: y,
                    x2: x + w,
                    y2: y,
                    col: Col::Border,
                    width: self.hair,
                });
                self.close(self.hair, 2.0 * FONT);
            }
            Block::FrontMatter(kv) => self.front_matter(kv, x, w),
            Block::Plain(text) => self.plain(text, x, w),
        }
    }

    fn paragraph(&mut self, inl: &[Inline], x: f32, w: f32, mb: f32, sep: Sep) {
        if let Some(imgs) = image_only(inl) {
            self.images(&imgs, x, w, mb);
            return;
        }
        let st = TextStyle::body(FONT);
        if let Some(t) = self.build(inl, &st, w) {
            let y = self.open(0.0);
            // 각주 참조가 처음 나온 자리를 적어 둔다(각주의 ↩ 가 여기로 돌아온다)
            let top_ref = max_footnote_ref(inl);
            if top_ref > self.fnref {
                for n in self.fnref + 1..=top_ref {
                    self.anchors.push((format!("fnref{n}").into(), y));
                }
                self.fnref = top_ref;
            }
            // 위첨자(각주 번호)나 인라인 수식이 든 줄은 렌더러에서 그만큼 높아진다(실측 +2.3px). 위첨자는 줄 윗선을 밀어 올려
            // 글자가 아래로 내려가고, 수식은 위아래로 나뉘므로 글자를 반만 내린다.
            let (grow, shift) = if max_footnote_ref(inl) > 0 {
                (SUP_LIFT, SUP_LIFT)
            } else if has_inline_math(inl) {
                (SUP_LIFT, SUP_LIFT / 2.0)
            } else {
                (0.0, 0.0)
            };
            let h = t.h + grow;
            self.push_text(t, x, y + shift, None, Some(sep));
            self.close(h, mb);
        }
    }

    /// 그림만 있는 문단. 그림은 글줄 안에 놓이므로 한 줄(그림 높이 + 글줄 아래 여백)을 차지하고, 가로로 놓이다 넘치면 다음 줄로 간다.
    /// 읽을 수 없는 그림(없는 파일 · 모르는 꼴)과 원격 그림은 한 줄을 끊고 자리표시자를 둔다.
    fn images(&mut self, imgs: &[ImgRef], x: f32, w: f32, mb: f32) {
        let y0 = self.open(0.0);
        let (mut cx, mut cy) = (0.0f32, 0.0f32);
        let mut row_h = 0.0f32;
        let space = 4.5;
        let mut mb = mb;
        for (src, alt, href) in imgs {
            match self.image_info(src) {
                ImgInfo::Local { w: iw, h: ih, path } => {
                    // max-width: 100%, height: auto
                    let dw = (iw as f32).min(w);
                    let dh = ih as f32 * dw / iw as f32;
                    if cx > 0.0 && cx + dw > w + 0.5 {
                        cy += row_h + IMG_DESCENT;
                        cx = 0.0;
                        row_h = 0.0;
                    }
                    self.items.push(Item::Image(ImageItem {
                        x: x + cx,
                        y: y0 + cy,
                        w: dw,
                        h: dh,
                        path: Arc::new(path),
                        href: href.clone(),
                    }));
                    cx += dw + space;
                    row_h = row_h.max(dh);
                }
                info => {
                    if row_h > 0.0 {
                        cy += row_h + IMG_DESCENT;
                        row_h = 0.0;
                    }
                    cx = 0.0;
                    let remote = matches!(info, ImgInfo::Remote);
                    if remote {
                        // 자리표시자 버튼의 아래 여백(1.1em)이 문단의 것과 겹쳐 큰 쪽이 된다
                        mb = mb.max(1.1 * FONT);
                    }
                    cy += self.image_note(alt, remote, x, y0 + cy, w);
                }
            }
        }
        if row_h > 0.0 {
            cy += row_h + IMG_DESCENT;
        }
        self.close(cy, mb);
    }

    fn image_info(&self, src: &str) -> ImgInfo {
        if super::md::is_remote(src) {
            return ImgInfo::Remote;
        }
        let Some(dir) = self.ctx.dir.as_deref() else {
            return ImgInfo::Missing;
        };
        let Some(path) = img::resolve_local(dir, src) else {
            return ImgInfo::Missing;
        };
        match img::sniff_file(&path) {
            Some((w, h)) => ImgInfo::Local { w, h, path },
            None => ImgInfo::Missing,
        }
    }

    /// 그릴 수 없는 그림의 대신 글. 원격 그림은 렌더러처럼 상자 안의 안내('이미지 불러오기 — 설명'), 못 읽는 그림은 `[그림: 설명]`.
    /// 놓은 높이를 돌려준다.
    fn image_note(&mut self, alt: &str, remote: bool, x: f32, y: f32, w: f32) -> f32 {
        if remote {
            // .md-image-placeholder: 상자(안쪽 12px · 최소 높이 48px). 렌더러는 점선이다.
            let label = if self.ctx.korean {
                format!(
                    "🖼 이미지 불러오기 — {}",
                    if alt.is_empty() { "이미지" } else { alt }
                )
            } else {
                format!(
                    "🖼 Load image — {}",
                    if alt.is_empty() { "image" } else { alt }
                )
            };
            let st = TextStyle {
                color: Some(Col::Muted),
                ..TextStyle::body(FONT)
            };
            let Some(t) = self.build(&[Inline::Text(label)], &st, w - 24.0) else {
                return 0.0;
            };
            let h = (t.h + 24.0).max(48.0);
            let r = [x, y, x + w, y + h];
            self.items.push(Item::Fill {
                r,
                col: Col::CodeBlock,
                radius: 8.0,
            });
            self.items.push(Item::Stroke {
                r,
                col: Col::Border,
                width: self.hair,
                radius: 8.0,
            });
            let ty = y + (h - t.h) / 2.0;
            self.push_text(t, x + 12.0, ty, None, None);
            h
        } else {
            let label = if alt.is_empty() {
                "[그림]".to_string()
            } else {
                format!("[그림: {alt}]")
            };
            let st = TextStyle {
                italic: true,
                color: Some(Col::Muted),
                ..TextStyle::body(FONT)
            };
            let Some(t) = self.build(&[Inline::Text(label)], &st, w) else {
                return 0.0;
            };
            let h = t.h;
            self.push_text(t, x, y, None, Some(Sep::Line));
            h
        }
    }

    fn code(&mut self, lang: &str, text: &str, x: f32, w: f32) {
        let size = FONT * 0.88;
        // 줄 간격은 <pre> 의 것이다(1.55 × 17px = 26.35px). 안의 <code>(1.55 × 14.96px)가 아니라 — 줄 상자는 둘 중 큰 쪽이다.
        let st = TextStyle {
            lh: FONT * 1.55 / size,
            mono: true,
            nowrap: true,
            ..TextStyle::body(size)
        };
        let (pad_y, pad_x) = (12.0, 14.0);
        let y = self.open(0.0);
        let src = if text.is_empty() { " " } else { text };
        let mut total = 0.0;
        let mut flat = Flat {
            keep_all: false,
            ..Flat::default()
        };
        flat.push_str(
            src,
            RunStyle {
                mono: true,
                ..Default::default()
            },
        );
        let spans = hl::highlight(lang, src);
        if let Some(t) = self.build_flat(flat, &st, 1.0e6, &spans) {
            // 가장 긴 줄이 상자 안쪽보다 길면 <pre> 가 가로 스크롤바를 상자 안 아래쪽에 단다 — 그만큼 높아진다(실측 10px).
            let inner_w = w - 2.0 * pad_x - 2.0 * self.hair;
            let bar = if t.w > inner_w + 0.5 {
                CODE_SCROLLBAR
            } else {
                0.0
            };
            let h = t.h + 2.0 * pad_y + 2.0 * self.hair + bar;
            total = h;
            let r = [x, y, x + w, y + h];
            self.items.push(Item::Fill {
                r,
                col: Col::CodeBlock,
                radius: 8.0,
            });
            self.items.push(Item::Stroke {
                r,
                col: Col::Border,
                width: self.hair,
                radius: 8.0,
            });
            let clip = [x + pad_x, y, x + w - pad_x, y + h];
            self.push_text(
                t,
                x + pad_x + self.hair,
                y + pad_y + self.hair,
                Some(clip),
                Some(Sep::Para),
            );
        }
        self.close(total, 1.1 * FONT);
    }

    /// 서식 없이 보여 주는 원문. 글 한 덩어리가 너무 크면 배치가 오래 걸리므로 줄 단위로 나눠 놓는다(덩어리 사이는 줄바꿈이다).
    fn plain(&mut self, text: &str, x: f32, w: f32) {
        let size = FONT * 0.94;
        let st = TextStyle {
            mono: true,
            ..TextStyle::body(size)
        };
        let mut y = self.open(0.0);
        let lines: Vec<&str> = text.split('\n').collect();
        let chunks: Vec<&[&str]> = lines.chunks(PLAIN_LINES).collect();
        let last = chunks.len().saturating_sub(1);
        for (i, chunk) in chunks.iter().enumerate() {
            let mut flat = Flat {
                keep_all: false,
                ..Flat::default()
            };
            flat.push_str(
                &chunk.join("\n"),
                RunStyle {
                    mono: true,
                    ..Default::default()
                },
            );
            // 빈 덩어리도 줄 높이는 있다
            if flat.text.is_empty() {
                flat.push_str(
                    " ",
                    RunStyle {
                        mono: true,
                        ..Default::default()
                    },
                );
            }
            if let Some(t) = self.build_flat(flat, &st, w, &[]) {
                let h = t.h;
                self.push_text(
                    t,
                    x,
                    y,
                    None,
                    Some(if i == last { Sep::Para } else { Sep::Line }),
                );
                y += h;
            }
        }
        self.y = y;
        self.pending = 0.0;
    }

    fn list(&mut self, ordered: bool, start: u64, items: &[ListItem], x: f32, w: f32) {
        // 할 일 목록(체크박스)은 들여쓰기 대신 상자 자리를 둔다(렌더러: .contains-task-list 0.2em · .task-list-item 1.6em).
        let is_task = items.first().map(|i| i.task.is_some()).unwrap_or(false);
        let li_x = if is_task {
            x + 0.2 * FONT
        } else {
            x + 1.4 * FONT
        };
        for (i, it) in items.iter().enumerate() {
            // li 의 위아래 여백 0.25em 이 이웃과 겹친다
            self.pending = self.pending.max(0.25 * FONT);
            let content_x = if it.task.is_some() {
                li_x + 1.6 * FONT
            } else {
                li_x
            };
            let before = self.items.len();
            self.blocks(&it.blocks, content_x, x + w - content_x, false);
            // 첫 줄 위치: 방금 놓은 첫 글의 y
            let first_y = self.items[before..]
                .iter()
                .find_map(|i| {
                    if let Item::Text { y, .. } = i {
                        Some(*y)
                    } else {
                        None
                    }
                })
                .unwrap_or(self.y);
            let lh = FONT * 1.75;
            match it.task {
                Some(checked) => {
                    let size = 0.95 * FONT;
                    self.items.push(Item::Check {
                        x: li_x,
                        y: first_y + (lh - size) / 2.0,
                        size,
                        checked,
                    });
                }
                None => {
                    let marker = if ordered {
                        format!("{}.", start + i as u64)
                    } else {
                        "•".to_string()
                    };
                    let st = TextStyle {
                        align: DWRITE_TEXT_ALIGNMENT_TRAILING,
                        ..TextStyle::body(FONT)
                    };
                    if let Some(t) = self.build(&[Inline::Text(marker)], &st, 3.0 * FONT) {
                        self.push_text(t, li_x - 3.0 * FONT - 0.3 * FONT, first_y, None, None);
                    }
                }
            }
            self.pending = self.pending.max(0.25 * FONT);
        }
        // 마지막 항목의 아래 여백(0.25em)은 목록의 아래 여백(1.1em)에 먹힌다.
        self.pending = self.pending.max(1.1 * FONT);
    }

    fn front_matter(&mut self, kv: &[(String, String)], x: f32, w: f32) {
        // 렌더러는 <details> 를 접어서 보여 준다 — 한 줄 요약(제목)만 보인다. 누르면 펴진다.
        let title = kv
            .iter()
            .find(|(k, _)| {
                ["title", "document", "문서", "제목"].contains(&k.to_lowercase().as_str())
            })
            .filter(|(_, v)| !v.trim().is_empty())
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| {
                if self.ctx.korean {
                    "문서 정보".to_string()
                } else {
                    "Document info".to_string()
                }
            });
        let size = FONT * 0.92;
        let st = TextStyle {
            color: Some(Col::Muted),
            ..TextStyle::body(size)
        };
        let head_h = 48.0;
        let y = self.open(0.0);
        // 펼친 표(th 30% · td 70%, 글자 0.9em, 칸 패딩 6px 14px, 테두리 1px)
        let open = self.ctx.fm_open && !kv.is_empty();
        let fsize = FONT * 0.9;
        let cell_st = |bold: bool| TextStyle {
            bold,
            color: if bold { Some(Col::Muted) } else { None },
            ..TextStyle::body(fsize)
        };
        let inner_w = w - 2.0 * self.hair;
        let (c1, c2) = (inner_w * 0.3, inner_w * 0.7);
        let mut rows: Vec<(Option<Built>, Option<Built>, f32)> = Vec::new();
        let mut table_h = 0.0;
        if open {
            for (k, v) in kv {
                let a = self.build(
                    &[Inline::Text(k.clone())],
                    &cell_st(true),
                    c1 - 28.0 - self.hair,
                );
                let b = self.build(
                    &[Inline::Text(v.clone())],
                    &cell_st(false),
                    c2 - 28.0 - self.hair,
                );
                let rh = a
                    .as_ref()
                    .map(|t| t.h)
                    .unwrap_or(0.0)
                    .max(b.as_ref().map(|t| t.h).unwrap_or(0.0))
                    .max(fsize * 1.75)
                    + 12.0
                    + self.hair;
                table_h += rh;
                rows.push((a, b, rh));
            }
        }
        let h = head_h + 2.0 * self.hair + table_h;
        let r = [x, y, x + w, y + h];
        // 요약 줄 바탕(상자를 따라 모서리가 둥글다. 펴 놓으면 아래 모서리만 각지게 덮는다)
        let sum_bottom = y + self.hair + head_h;
        self.items.push(Item::Fill {
            r: [x, y, x + w, if open { sum_bottom } else { y + h }],
            col: Col::CodeInline,
            radius: 8.0,
        });
        if open {
            self.items.push(Item::Fill {
                r: [x, y + 8.0, x + w, sum_bottom],
                col: Col::CodeInline,
                radius: 0.0,
            });
        }
        self.hots
            .push((Hot::FrontMatter, [x, y, x + w, y + head_h + self.hair]));
        let arrow = if open { "▾ " } else { "▸ " };
        if let Some(t) = self.build(&[Inline::Text(format!("{arrow}{title}"))], &st, w - 28.0) {
            let ty = y + self.hair + (head_h - t.h) / 2.0;
            self.push_text(t, x + 14.0, ty, None, None);
        }
        let mut ry = y + self.hair + head_h;
        for (a, b, rh) in rows {
            self.items.push(Item::Fill {
                r: [x + self.hair, ry, x + self.hair + c1, ry + rh],
                col: Col::CodeInline,
                radius: 0.0,
            });
            if let Some(t) = a {
                self.push_text(t, x + self.hair + 14.0, ry + 6.0, None, Some(Sep::Tab));
            }
            if let Some(t) = b {
                self.push_text(
                    t,
                    x + self.hair + c1 + 14.0,
                    ry + 6.0,
                    None,
                    Some(Sep::Line),
                );
            }
            self.items.push(Item::Line {
                x1: x,
                y1: ry,
                x2: x + w,
                y2: ry,
                col: Col::Border,
                width: self.hair,
            });
            ry += rh;
        }
        if open {
            self.items.push(Item::Line {
                x1: x + self.hair + c1,
                y1: y + self.hair + head_h,
                x2: x + self.hair + c1,
                y2: ry,
                col: Col::Border,
                width: self.hair,
            });
        }
        // 테두리는 맨 위에(모서리를 둥글게 덮는다)
        self.items.push(Item::Stroke {
            r,
            col: Col::Border,
            width: self.hair,
            radius: 8.0,
        });
        self.close(h, 1.5 * FONT);
    }

    fn footnotes(&mut self, notes: &[Vec<Block>], x: f32, w: f32) {
        let size = FONT * 0.92;
        // markdown-it-footnote 는 <hr class="footnotes-sep"> 와 <section class="footnotes"> 를 잇따라 낸다 — 선이 둘이다.
        let sep = self.open(2.0 * FONT);
        self.items.push(Item::Line {
            x1: x,
            y1: sep,
            x2: x + w,
            y2: sep,
            col: Col::Border,
            width: self.hair,
        });
        self.y = sep + self.hair;
        self.pending = 2.0 * FONT;
        let top = self.open(2.5 * size);
        self.items.push(Item::Line {
            x1: x,
            y1: top,
            x2: x + w,
            y2: top,
            col: Col::Border,
            width: self.hair,
        });
        self.y = top + self.hair + size; // padding-top: 1em
        self.pending = 0.0;

        let content_x = x + 1.4 * size;
        for (i, blocks) in notes.iter().enumerate() {
            let st = TextStyle {
                color: Some(Col::Muted),
                ..TextStyle::body(size)
            };
            let mut inl: Vec<Inline> = Vec::new();
            for b in blocks {
                if let Block::Paragraph(p) | Block::Tight(p) = b {
                    inl.extend(p.iter().cloned());
                }
            }
            // 되돌아가기 화살표(↩)가 글 끝에 붙는다
            inl.push(Inline::Text(" ".into()));
            inl.push(Inline::Link {
                href: format!("#fnref{}", i + 1).into(),
                children: vec![Inline::Text("↩".into())],
            });
            if let Some(t) = self.build(&inl, &st, x + w - content_x) {
                let yy = self.open(0.25 * size);
                let h = t.h;
                self.anchors.push((format!("fn{}", i + 1).into(), yy));
                self.push_text(t, content_x, yy, None, Some(Sep::Line));
                let marker = TextStyle {
                    align: DWRITE_TEXT_ALIGNMENT_TRAILING,
                    color: Some(Col::Muted),
                    ..TextStyle::body(size)
                };
                if let Some(m) =
                    self.build(&[Inline::Text(format!("{}.", i + 1))], &marker, 3.0 * size)
                {
                    self.push_text(m, content_x - 3.0 * size - 0.3 * size, yy, None, None);
                }
                self.close(h, 0.25 * size);
            }
        }
    }

    // ── 표 ───────────────────────────────────────────────────────────────────

    fn table(
        &mut self,
        aligns: &[Align],
        head: &[Vec<Inline>],
        rows: &[Vec<Vec<Inline>>],
        x: f32,
        w: f32,
    ) {
        let base_size = FONT * 0.94;
        let (pad_x, pad_y) = (11.0, 7.0);
        let n = head
            .len()
            .max(rows.iter().map(|r| r.len()).max().unwrap_or(0))
            .max(1);
        let extra = 2.0 * pad_x + self.hair;
        let mut all_rows: Vec<(Vec<Vec<Inline>>, bool)> = Vec::with_capacity(rows.len() + 1);
        all_rows.push((head.to_vec(), true));
        for r in rows {
            all_rows.push((r.clone(), false));
        }

        // 칸마다 최대 내용 너비 · 최소 내용 너비를 재고, 글자 크기를 줄일 만큼(fit-width.ts)을 정한다.
        let measure = |this: &Self, size: f32| -> (Vec<f32>, Vec<f32>) {
            let cell_style = |col: usize, bold: bool| TextStyle {
                bold,
                align: match aligns.get(col).copied().unwrap_or(Align::Left) {
                    Align::Left => DWRITE_TEXT_ALIGNMENT_LEADING,
                    Align::Center => DWRITE_TEXT_ALIGNMENT_CENTER,
                    Align::Right => DWRITE_TEXT_ALIGNMENT_TRAILING,
                },
                ..TextStyle::body(size)
            };
            let mut max_c = vec![0.0f32; n];
            let mut min_c = vec![0.0f32; n];
            for (cells, bold) in &all_rows {
                for (c, inl) in cells.iter().enumerate().take(n) {
                    if let Some(t) = this.build(inl, &cell_style(c, *bold), 1.0e5) {
                        max_c[c] = max_c[c].max(t.w);
                        let mw = unsafe { t.layout.DetermineMinWidth().unwrap_or(0.0) };
                        min_c[c] = min_c[c].max(mw);
                    }
                }
            }
            (max_c, min_c)
        };
        let (mut max_c, mut min_c) = measure(self, base_size);
        let mut size = base_size;
        let need = min_c.iter().sum::<f32>() + n as f32 * extra;
        if need > w + 1.0 {
            // 접어도 안 들어가면 글자를 줄인다(패딩은 그대로이므로 글자 몫만 비례해서 줄인다). 바닥 아래로는 줄이지 않는다.
            let text_part = min_c.iter().sum::<f32>().max(1.0);
            let scale = ((w - n as f32 * extra) / text_part).clamp(FIT_FLOOR, 1.0);
            if scale < 1.0 {
                size = base_size * scale;
                let m = measure(self, size);
                max_c = m.0;
                min_c = m.1;
            }
        }
        let cell_style = |col: usize, bold: bool| TextStyle {
            bold,
            align: match aligns.get(col).copied().unwrap_or(Align::Left) {
                Align::Left => DWRITE_TEXT_ALIGNMENT_LEADING,
                Align::Center => DWRITE_TEXT_ALIGNMENT_CENTER,
                Align::Right => DWRITE_TEXT_ALIGNMENT_TRAILING,
            },
            ..TextStyle::body(size)
        };
        let natural: Vec<f32> = max_c.iter().map(|m| m + extra).collect();
        let minimum: Vec<f32> = (0..n).map(|c| (min_c[c] + extra).min(natural[c])).collect();

        // 표는 항상 본문 너비를 채운다(렌더러: width 100%). 남는 너비는 자연 너비 비율로 나눈다.
        let sum_nat: f32 = natural.iter().sum();
        let sum_min: f32 = minimum.iter().sum();
        let colw: Vec<f32> = if sum_nat <= w {
            natural.iter().map(|nat| nat * (w / sum_nat)).collect()
        } else if sum_min >= w {
            minimum.iter().map(|min| min * (w / sum_min)).collect()
        } else {
            let room = w - sum_min;
            let want: f32 = natural
                .iter()
                .zip(&minimum)
                .map(|(nat, min)| nat - min)
                .sum();
            natural
                .iter()
                .zip(&minimum)
                .map(|(nat, min)| min + room * ((nat - min) / want.max(1e-3)))
                .collect()
        };
        let mut xs = vec![x];
        for cw in &colw {
            xs.push(xs[xs.len() - 1] + cw);
        }

        let y0 = self.open(0.0);
        let mut y = y0;
        let mut row_tops = vec![y];
        let last_row = all_rows.len() - 1;
        for (ri, (cells, bold)) in all_rows.iter().enumerate() {
            let mut built: Vec<Option<Built>> = Vec::new();
            let mut row_h = 0.0f32;
            for (c, cw) in colw.iter().enumerate() {
                let b = cells
                    .get(c)
                    .and_then(|inl| self.build(inl, &cell_style(c, *bold), cw - extra));
                row_h = row_h.max(b.as_ref().map(|t| t.h).unwrap_or(size * 1.75));
                built.push(b);
            }
            let h = row_h + 2.0 * pad_y + self.hair;
            if *bold {
                self.items.push(Item::Fill {
                    r: [x, y, x + w, y + h],
                    col: Col::CodeInline,
                    radius: 0.0,
                });
            }
            let count = built.len();
            for (c, b) in built.into_iter().enumerate() {
                if let Some(t) = b {
                    let sep = if c + 1 == count {
                        if ri == last_row {
                            Sep::Para
                        } else {
                            Sep::Line
                        }
                    } else {
                        Sep::Tab
                    };
                    self.push_text(
                        t,
                        xs[c] + pad_x + self.hair,
                        y + pad_y + self.hair,
                        None,
                        Some(sep),
                    );
                }
            }
            y += h;
            row_tops.push(y);
        }
        // 격자선
        for &ry in &row_tops {
            self.items.push(Item::Line {
                x1: x,
                y1: ry,
                x2: x + w,
                y2: ry,
                col: Col::Border,
                width: self.hair,
            });
        }
        for &cx in &xs {
            self.items.push(Item::Line {
                x1: cx,
                y1: y0,
                x2: cx,
                y2: y,
                col: Col::Border,
                width: self.hair,
            });
        }
        self.close(y - y0, 1.1 * FONT);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::md;
    use super::*;
    use windows::Win32::Graphics::Direct2D::Common::{
        D2D1_ALPHA_MODE_IGNORE, D2D1_COLOR_F, D2D1_PIXEL_FORMAT,
    };
    use windows::Win32::Graphics::Direct2D::{
        D2D1CreateFactory, ID2D1Factory, D2D1_FACTORY_TYPE_SINGLE_THREADED,
        D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_SOFTWARE,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

    const COL_W: f32 = 672.0;

    /// 창 없이 글꼴과 붓을 만든다(붓은 렌더 타깃에서 나온다). 못 만들면 시험을 건너뛴다.
    pub(crate) fn harness() -> Option<(Gfx, Brushes)> {
        unsafe {
            let dw: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).ok()?;
            let factory: ID2D1Factory =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).ok()?;
            let props = D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_SOFTWARE,
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                ..Default::default()
            };
            let rt = factory.CreateDCRenderTarget(&props).ok()?;
            let mut brushes = Brushes {
                b: Vec::with_capacity(COLS),
            };
            for c in palette(false) {
                let color = D2D1_COLOR_F {
                    r: c[0],
                    g: c[1],
                    b: c[2],
                    a: c[3],
                };
                brushes.b.push(rt.CreateSolidColorBrush(&color, None).ok()?);
            }
            Some((Gfx::new(dw), brushes))
        }
    }

    /// 문서를 놓고 (놓은 것, 최상위 블록들의 높이)를 돌려준다.
    pub(crate) fn lay(g: &(Gfx, Brushes), src: &str, slice_to: Option<f32>) -> Layout {
        lay_ctx(g, src, slice_to, &Ctx::plain())
    }

    pub(crate) fn lay_ctx(
        g: &(Gfx, Brushes),
        src: &str,
        slice_to: Option<f32>,
        ctx: &Ctx,
    ) -> Layout {
        let doc = md::parse(src);
        let mut p = Progress::default();
        let mut all = Layout::empty();
        loop {
            let mut l = Layouter::resume(&g.0, &g.1, ctx, 1.0 / 1.5, &p);
            let until = slice_to.map(|s| l.y + l.pending + s).unwrap_or(f32::MAX);
            l.advance(&doc, &mut p, 0.0, COL_W, until, None);
            let mut part = l.finish();
            all.items.append(&mut part.items);
            all.boxes.append(&mut part.boxes);
            all.anchors.append(&mut part.anchors);
            all.block_tops.append(&mut part.block_tops);
            all.height = part.height;
            if p.done(&doc) {
                return all;
            }
        }
    }

    fn near(a: f32, b: f32, tol: f32) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn tight_item_with_leading_bold_is_not_split() {
        let Some(g) = harness() else { return };
        // 줄 높이 17×1.75=29.75, 항목 사이 여백 0.25em=4.25 → 두 줄이 한 항목씩이면 63.75
        // (예전에는 **굵게** 로 시작하는 항목이 문단 둘로 쪼개져 훨씬 높았다)
        let l = lay(
            &g,
            "앞 문단

- **굵게** — 한 줄
- 둘째 줄
",
            None,
        );
        let list = l.boxes.iter().find(|b| b.0 == "list").expect("목록 상자");
        assert!(
            near(list.2 - list.1, 63.75, 0.6),
            "목록 높이 {}",
            list.2 - list.1
        );
    }

    #[test]
    fn code_block_follows_pre_line_pitch() {
        let Some(g) = harness() else { return };
        // 세 줄: 3 × (1.55 × 17) + 위아래 패딩 24 + 테두리 2칸
        let l = lay(&g, "```\na\nb\nc\n```\n", None);
        let hair = 1.0 / 1.5;
        let want = 3.0 * 26.35 + 24.0 + 2.0 * hair;
        let top = l.boxes[0];
        assert!(
            near(top.2 - top.1, want, 0.6),
            "코드 상자 {}",
            top.2 - top.1
        );
    }

    #[test]
    fn code_block_wider_than_box_grows_by_scrollbar() {
        let Some(g) = harness() else { return };
        let short = lay(&g, "```\nab\n```\n", None);
        let long_line = "x".repeat(400);
        let long = lay(&g, &format!("```\n{long_line}\n```\n"), None);
        let h = |l: &Layout| l.boxes[0].2 - l.boxes[0].1;
        assert!(near(h(&long) - h(&short), CODE_SCROLLBAR, 0.6));
    }

    #[test]
    fn footnote_ref_and_inline_math_make_the_paragraph_taller() {
        let Some(g) = harness() else { return };
        let plain = lay(&g, "본문 한 줄\n", None).height;
        let sup = lay(&g, "본문 한 줄[^1]\n\n[^1]: 각주\n", None);
        let math = lay(&g, "본문 $x$ 한 줄\n", None).height;
        // 문단 높이(= 블록 상자) 로 견준다. 각주 구역은 따로 놓인다.
        let sup_p = sup.boxes[0];
        assert!(near(sup_p.2 - sup_p.1, 29.75, 1.0)); // 글 상자 자체는 그대로
        assert!(
            near(math - plain, SUP_LIFT, 0.3),
            "수식 문단 {math} / 일반 {plain}"
        );
    }

    #[test]
    fn slicing_the_layout_gives_the_same_result_as_one_pass() {
        let Some(g) = harness() else { return };
        let mut src = String::new();
        for i in 0..40 {
            src.push_str(&format!(
                "## 제목 {i}\n\n본문 {i} 입니다.\n\n- 하나\n- 둘\n\n"
            ));
        }
        let whole = lay(&g, &src, None);
        let sliced = lay(&g, &src, Some(300.0));
        assert_eq!(whole.items.len(), sliced.items.len());
        assert!(
            near(whole.height, sliced.height, 0.01),
            "{} vs {}",
            whole.height,
            sliced.height
        );
    }

    #[test]
    fn headings_and_footnotes_leave_anchors_and_reading_order_numbers() {
        let Some(g) = harness() else { return };
        let l = lay(
            &g,
            "# 첫 제목\n\n본문[^1]\n\n## 둘째\n\n[^1]: 각주 글\n",
            None,
        );
        let ids: Vec<String> = l.anchors.iter().map(|(i, _)| i.to_string()).collect();
        let want_first = md::encode_uri_component("첫-제목");
        assert!(ids.contains(&want_first), "{ids:?}");
        assert!(ids.contains(&"fn1".to_string()) && ids.contains(&"fnref1".to_string()));
        // y 는 문서 순서로 늘어난다(첫 제목 < 둘째 < 각주)
        let y_of = |id: &str| l.anchors.iter().find(|(i, _)| &**i == id).unwrap().1;
        assert!(y_of(&want_first) < y_of(&md::encode_uri_component("둘째")));
        assert!(y_of(&md::encode_uri_component("둘째")) < y_of("fn1"));
        // 읽는 순서 번호는 0 부터 빠짐없이
        let ords: Vec<u32> = l
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Text { meta: Some(m), .. } => Some(m.ord),
                _ => None,
            })
            .collect();
        assert_eq!(ords, (0..ords.len() as u32).collect::<Vec<_>>());
        assert!(ords.len() >= 4);
    }

    #[test]
    fn links_become_spans_over_the_text() {
        let Some(g) = harness() else { return };
        let l = lay(&g, "앞 [링크 글](https://a.example) 뒤 [내부](#절)\n", None);
        let meta = l
            .items
            .iter()
            .find_map(|i| match i {
                Item::Text { meta: Some(m), .. } => Some(m),
                _ => None,
            })
            .unwrap();
        assert_eq!(meta.links.len(), 2);
        let s = &meta.links[0];
        let txt = String::from_utf16_lossy(&meta.text[s.start as usize..s.end as usize])
            .replace('\u{2060}', "");
        assert!(txt.contains("링크"), "{txt}");
        assert_eq!(&*s.href, "https://a.example");
        assert_eq!(&*meta.links[1].href, "#절");
    }

    #[test]
    fn code_text_has_no_word_joiners_so_colors_line_up() {
        let Some(g) = harness() else { return };
        let l = lay(&g, "```js\n// 한글 주석\nlet a = 1;\n```\n", None);
        let meta = l
            .items
            .iter()
            .find_map(|i| match i {
                Item::Text { meta: Some(m), .. } => Some(m),
                _ => None,
            })
            .unwrap();
        assert!(!meta.text.contains(&0x2060));
        assert_eq!(
            String::from_utf16_lossy(&meta.text),
            "// 한글 주석\nlet a = 1;"
        );
    }

    #[test]
    fn a_wide_table_shrinks_its_text_instead_of_breaking_words() {
        let Some(g) = harness() else { return };
        let cols = 8;
        let head = (0..cols)
            .map(|i| format!("열{i}"))
            .collect::<Vec<_>>()
            .join(" | ");
        let sep = (0..cols).map(|_| "---").collect::<Vec<_>>().join(" | ");
        let row = (0..cols)
            .map(|_| "Internationalization")
            .collect::<Vec<_>>()
            .join(" | ");
        let narrow = lay(&g, &format!("| {head} |\n| {sep} |\n| {row} |\n"), None);
        // 글자를 줄여 한 줄에 들어간다 — 표 높이가 두 줄 + 머리 한 줄(줄이지 않았다면 낱말이 쪼개져 훨씬 높다)
        let t = narrow.boxes.iter().find(|b| b.0 == "table").unwrap();
        assert!(t.2 - t.1 < 110.0, "표 높이 {}", t.2 - t.1);
    }

    /// 연구용(느리다): 한 문단의 길이에 따라 배치 시간이 어떻게 느는지. `cargo test --release paragraph_scaling -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn paragraph_scaling() {
        let Some(g) = harness() else { return };
        for n in [5_000usize, 20_000, 50_000, 100_000, 200_000] {
            let src = "한글 단어 word ".repeat(n / 11) + "\n";
            let t = std::time::Instant::now();
            let l = lay(&g, &src, None);
            println!(
                "{n:>7}자 문단: {:>6} ms (높이 {:.0})",
                t.elapsed().as_millis(),
                l.height
            );
        }
        for n in [20_000usize, 100_000, 400_000] {
            let src = format!("```\n{}\n```\n", "x = 1; // 주석 한 줄\n".repeat(n / 20));
            let t = std::time::Instant::now();
            let _ = lay(&g, &src, None);
            println!("{n:>7}자 코드: {:>6} ms", t.elapsed().as_millis());
        }
    }

    #[test]
    fn plain_text_is_chunked_but_keeps_every_line() {
        let Some(g) = harness() else { return };
        let doc = md::parse_plain(
            &(0..300)
                .map(|i| format!("줄 {i}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let mut p = Progress::default();
        let ctx = Ctx::plain();
        let mut l = Layouter::resume(&g.0, &g.1, &ctx, 1.0 / 1.5, &p);
        l.advance(&doc, &mut p, 0.0, COL_W, f32::MAX, None);
        let lay = l.finish();
        let texts: Vec<&TextMeta> = lay
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Text { meta: Some(m), .. } => Some(&**m),
                _ => None,
            })
            .collect();
        assert_eq!(texts.len(), 3); // 300 줄 / 120 줄
        let joined: String = texts
            .iter()
            .map(|m| {
                format!(
                    "{}{}",
                    String::from_utf16_lossy(&m.text),
                    if m.sep == Sep::Line { "\n" } else { "" }
                )
            })
            .collect();
        assert!(joined.starts_with("줄 0\n줄 1") && joined.ends_with("줄 299"));
        assert_eq!(joined.matches('\n').count(), 299);
    }
}
