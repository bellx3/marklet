//! 문서 하나를 보는 상태 — 배치 · 스크롤 · 고르기 · 찾기 · 목차. 창(HWND)을 모른다.
//!
//! 창(window.rs)은 입력을 이 상태에 알리고, 이 상태가 그려 달라고 하면 그린다(paint.rs). 그래서 창 없이도 시험할 수 있다.
//!
//! 좌표
//!   · 배치(`Layout`)는 **본문 칸 왼쪽 위**를 원점으로 하는 CSS px 다. 칸이 화면 어디에 놓이는지(`col_x`)는 그릴 때 더한다 —
//!     목차 도크를 열고 닫아도 칸의 너비가 같으면 다시 놓지 않는다.
//!   · 입력은 클라이언트 영역의 물리 px. `scale()`(= 화면 배율 × 확대)로 CSS px 로 바꾼다.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use windows::Win32::Graphics::Direct2D::ID2D1Bitmap;
use windows::Win32::Graphics::DirectWrite::*;

use super::find::Find;
use super::layout::{Brushes, Ctx, Gfx, Hot, Item, Layout, Layouter, Progress};
use super::md::{self, Doc};

pub const SCROLLBAR: f32 = 10.0;
pub const MD_MEASURE: f32 = 736.0;
pub const PAD_X: f32 = 32.0;
pub const PAD_TOP: f32 = 40.0;
pub const PAD_BOTTOM: f32 = 120.0;
/// 처음에 보이는 화면 아래로 더 놓아 두는 높이(CSS px). 스크롤을 조금 내려도 빈 데가 안 보이게.
pub const FIRST_EXTRA: f32 = 600.0;
/// 목차 도크의 너비(17.5rem)
pub const DOCK_W: f32 = 280.0;
/// 제목으로 이동할 때 위에 남기는 여백(scroll-margin-top)
pub const JUMP_MARGIN: f32 = 64.0;
/// 이 높이 안에 들어온 가장 아래 제목이 '지금 읽는 절'이다
pub const READING_LINE: f32 = 120.0;

/// 글 안의 한 자리: 읽는 순서 번호 + 그 글의 UTF-16 위치
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Pos {
    pub ord: u32,
    pub off: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Selection {
    pub anchor: Pos,
    pub focus: Pos,
}

impl Selection {
    pub fn ordered(&self) -> (Pos, Pos) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }
    pub fn is_empty(&self) -> bool {
        self.anchor == self.focus
    }
}

/// 누른 자리에서 찾은 것
#[derive(Clone, Debug)]
pub struct Hit {
    pub pos: Pos,
    /// 글자 위인가(글 상자 밖이면 가장 가까운 글자로 끌려온 것이다)
    pub inside: bool,
    pub link: Option<Arc<str>>,
}

/// 누른 자리가 문서가 아니라 화면 장치(막대 · 도크 · 스크롤바)일 때
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ui {
    FindInput,
    FindPrev,
    FindNext,
    FindClose,
    /// 막대 안의 빈 곳(문서로 새지 않게 먹는다)
    FindBar,
    DockClose,
    DockItem(usize),
    /// 떠오르는 컨트롤의 단추(0 편집 · 1 목차 · 2 찾기 · 3 테마 · 4 더보기)
    Ctl(u8),
    /// 컨트롤 막대의 빈 곳(문서로 새지 않게 먹는다)
    CtlBar,
    /// 도크의 빈 곳
    DockArea,
    Thumb,
    Track,
}

/// 그림이 읽혀 있는가
pub enum ImgSlot {
    Loading,
    Ready(ID2D1Bitmap),
    Failed,
}

/// 목차 도크의 한 줄
pub struct DockItem {
    pub layout: IDWriteTextLayout,
    /// 목록 안 위치(CSS px, 목록 맨 위 = 0)
    pub top: f32,
    pub h: f32,
    pub level: u8,
    /// doc.headings 의 번호
    pub heading: usize,
}

pub struct View {
    pub gfx: Gfx,
    pub brushes: Brushes,
    /// 원문(원문 보기 · 다시 읽기용)
    pub src: Arc<String>,
    /// 지금 서식 없이 원문으로 보여 주는가(.txt 는 처음부터 그렇고, 원문 보기를 켜면 그렇다)
    pub plain_view: bool,
    pub doc: Doc,
    pub ctx: Ctx,
    pub layout: Layout,
    pub progress: Progress,
    pub anchor_y: HashMap<Arc<str>, f32>,

    pub dark: bool,
    pub zoom: f32,
    /// 화면 배율(DPI/96)
    pub dpi: f32,
    /// 클라이언트 크기(물리 px)
    pub cw: u32,
    pub ch: u32,
    pub scroll: f32,
    /// 부드럽게 굴러가는 목표(스크롤이 끝나면 scroll 과 같다)
    pub scroll_target: f32,
    /// 본문 칸 왼쪽의 화면 위치와 너비(CSS px)
    pub col_x: f32,
    pub col_w: f32,

    pub sel: Option<Selection>,
    pub find: Find,
    pub find_open: bool,

    pub dock_open: bool,
    pub dock_items: Vec<DockItem>,
    pub dock_scroll: f32,
    pub dock_hover: Option<usize>,
    pub dock_content_h: f32,
    /// 마우스가 올라가 있는 화면 장치 · 스크롤바 손잡이(밝게 그린다)
    pub ui_hover: Option<Ui>,
    pub thumb_hot: bool,
    /// 떠오르는 컨트롤이 보이는가 · 눌러서 고정했는가 · 마우스를 올린 지 얼마나 됐는가(툴팁)
    pub ctl_shown: bool,
    pub ctl_pinned: bool,
    pub ctl_hover_since: Option<Instant>,
    /// 열려 있는 우클릭 · 더 보기 메뉴(창 안에 그린다 — menu.rs)
    pub popup: Option<super::menu::Popup>,

    pub images: HashMap<std::path::PathBuf, ImgSlot>,
    /// 그리다가 필요하다고 본 그림(읽기 시작하지 않은 것) — 창이 가져가 읽는다
    pub want_images: Vec<Arc<std::path::PathBuf>>,
}

impl View {
    pub fn new(gfx: Gfx, brushes: Brushes, doc: Doc, src: Arc<String>, ctx: Ctx) -> View {
        let mut v = View {
            gfx,
            brushes,
            src,
            plain_view: false,
            doc,
            ctx,
            layout: Layout::empty(),
            progress: Progress::default(),
            anchor_y: HashMap::new(),
            dark: false,
            zoom: 1.0,
            dpi: 1.0,
            cw: 1,
            ch: 1,
            scroll: 0.0,
            scroll_target: 0.0,
            col_x: 0.0,
            col_w: 0.0,
            sel: None,
            find: Find::default(),
            find_open: false,
            dock_open: false,
            dock_items: Vec::new(),
            dock_scroll: 0.0,
            dock_hover: None,
            dock_content_h: 0.0,
            ui_hover: None,
            thumb_hot: false,
            ctl_shown: false,
            ctl_pinned: false,
            ctl_hover_since: None,
            popup: None,
            images: HashMap::new(),
            want_images: Vec::new(),
        };
        v.progress.y = PAD_TOP;
        v
    }

    pub fn scale(&self) -> f32 {
        self.dpi * self.zoom
    }
    pub fn view_h(&self) -> f32 {
        self.ch as f32 / self.scale()
    }
    pub fn view_w(&self) -> f32 {
        self.cw as f32 / self.scale()
    }
    pub fn hair(&self) -> f32 {
        1.0 / self.scale()
    }

    /// 본문 칸의 왼쪽 위치(화면)와 너비. 창 너비 · 도크에서 정해진다.
    pub fn column(&self) -> (f32, f32) {
        let dock = if self.dock_open { DOCK_W } else { 0.0 };
        let vw = self.view_w() - SCROLLBAR - dock;
        let md = vw.clamp(120.0, MD_MEASURE);
        let x = dock + ((vw - md) / 2.0).max(0.0) + PAD_X;
        (x, (md - 2.0 * PAD_X).max(80.0))
    }

    // ── 배치 ───────────────────────────────────────────────────────────────

    /// 지금 읽는 자리: (맨 위에 걸친 최상위 블록 번호, 그 블록 위에서 얼마나 내려왔나). 다시 놓은 뒤에도 같은 블록에 머물게 한다.
    fn reading_anchor(&self) -> Option<(usize, f32)> {
        let tops = &self.layout.block_tops;
        if tops.is_empty() || self.scroll <= 0.0 {
            return None;
        }
        let i = tops.partition_point(|t| *t <= self.scroll).checked_sub(1)?;
        Some((i, self.scroll - tops[i]))
    }

    /// 처음부터 다시 놓는다(크기 · 배율이 바뀌었을 때). 첫 화면(과 조금 아래)까지만 놓고 나머지는 틈틈이 이어 놓는다.
    /// 읽던 블록은 그대로 유지한다(창을 좁히면 글이 길어져 같은 y 는 다른 글이 되므로).
    pub fn relayout(&mut self) {
        let anchor = self.reading_anchor();
        let (x, w) = self.column();
        self.col_x = x;
        self.col_w = w;
        self.layout = Layout::empty();
        self.anchor_y.clear();
        self.progress = Progress {
            y: PAD_TOP,
            ..Progress::default()
        };
        // 연구용 덤프는 문서 전체가 있어야 한다.
        let all = std::env::var_os("MARKLET_PREVIEW_DUMP").is_some();
        let until = if all {
            f32::MAX
        } else {
            self.scroll + self.view_h() + FIRST_EXTRA
        };
        self.more(until, None);
        // 읽던 블록까지 놓고 그 자리로 돌아간다
        if let Some((idx, delta)) = anchor {
            while self.layout.block_tops.len() <= idx && !self.is_done() {
                let next = self.progress.y + self.view_h() * 2.0;
                self.more(next, None);
            }
            if let Some(top) = self.layout.block_tops.get(idx).copied() {
                self.scroll = top + delta;
                self.scroll_target = self.scroll;
                let need = self.scroll + self.view_h() + FIRST_EXTRA;
                if self.progress.y < need && !self.is_done() {
                    self.more(need, None);
                }
            }
        }
        self.rebuild_dock();
    }

    /// 칸 너비가 같으면 다시 놓지 않고 위치만 옮긴다(도크를 열고 닫을 때). 달라졌으면 다시 놓는다.
    pub fn reflow(&mut self) {
        let (x, w) = self.column();
        if (w - self.col_w).abs() < 0.01 && !self.layout.items.is_empty() {
            self.col_x = x;
            self.rebuild_dock();
        } else {
            self.relayout();
        }
    }

    /// 놓은 자리에서 이어 놓는다. until_y(문서 좌표)에 닿거나 deadline 이 지나면 멈춘다. 다 놓았으면 true.
    pub fn more(&mut self, until_y: f32, deadline: Option<Instant>) -> bool {
        let hair = self.hair();
        let View {
            gfx,
            brushes,
            ctx,
            doc,
            progress,
            layout,
            anchor_y,
            col_w,
            ..
        } = self;
        let mut l = Layouter::resume(gfx, brushes, ctx, hair, progress);
        l.advance(doc, progress, 0.0, *col_w, until_y, deadline);
        let mut chunk = l.finish();

        let base = layout.items.len();
        for (k, it) in chunk.items.iter().enumerate() {
            if let Item::Text { meta: Some(m), .. } = it {
                debug_assert_eq!(m.ord as usize, layout.sel.len());
                layout.sel.push((base + k) as u32);
            }
        }
        for (id, y) in &chunk.anchors {
            anchor_y.entry(id.clone()).or_insert(*y);
        }
        layout.items.append(&mut chunk.items);
        layout.boxes.append(&mut chunk.boxes);
        layout.anchors.append(&mut chunk.anchors);
        layout.hots.append(&mut chunk.hots);
        layout.block_tops.append(&mut chunk.block_tops);

        let p = *progress;
        let done = p.done(doc);
        let used = p.y + p.pending;
        layout.height = if done {
            used + PAD_BOTTOM
        } else {
            // 아직 안 놓은 블록의 높이는 지금까지의 평균으로 어림한다(스크롤 막대가 너무 작아지지 않게).
            let avg = (used - PAD_TOP) / p.next.max(1) as f32;
            used + avg * (doc.blocks.len() - p.next) as f32 + PAD_BOTTOM
        };
        if done {
            // 연구용: 블록 위치를 파일로 내보내 렌더러의 실제 위치와 맞대 본다.
            if let Some(path) = std::env::var_os("MARKLET_PREVIEW_DUMP") {
                let lines: Vec<String> = layout
                    .boxes
                    .iter()
                    .map(|(k, t, b)| format!("{k} {t:.1} {:.1}", b - t))
                    .collect();
                let _ = std::fs::write(path, lines.join("\n"));
            }
        }
        done
    }

    pub fn is_done(&self) -> bool {
        self.progress.done(&self.doc)
    }

    /// 보이는 곳(과 조금 아래)까지는 놓여 있게 한다. 스크롤이 놓은 데를 앞질렀을 때 부른다.
    pub fn ensure(&mut self) {
        if self.is_done() {
            return;
        }
        let need = self.scroll.max(self.scroll_target) + self.view_h() + FIRST_EXTRA;
        if self.progress.y < need {
            self.more(need, None);
        }
    }

    /// 문서 끝까지 놓는다(찾기 · 모두 선택 · 끝으로 가기).
    pub fn ensure_all(&mut self) {
        if !self.is_done() {
            self.more(f32::MAX, None);
        }
    }

    /// 읽는 순서 번호 ord 까지는 놓여 있게 한다.
    pub fn ensure_ord(&mut self, ord: u32) {
        while self.layout.sel.len() as u32 <= ord && !self.is_done() {
            let target = self.progress.y + self.view_h() * 2.0;
            self.more(target, None);
        }
    }

    pub fn clamp(&mut self) {
        let max = (self.layout.height - self.view_h()).max(0.0);
        self.scroll = self.scroll.clamp(0.0, max);
        self.scroll_target = self.scroll_target.clamp(0.0, max);
    }

    // ── 스크롤 ─────────────────────────────────────────────────────────────

    /// 부드럽게 dy 만큼 굴린다(휠 · 키보드). 끝에 닿으면 멈춘다.
    pub fn scroll_by(&mut self, dy: f32) {
        self.scroll_target += dy;
        self.after_scroll_target();
    }

    /// 목표 위치로 바로 간다(스크롤바 끌기 · 목차 이동).
    pub fn scroll_to(&mut self, y: f32, animate: bool) {
        self.scroll_target = y;
        if !animate {
            self.scroll = y;
        }
        self.after_scroll_target();
    }

    fn after_scroll_target(&mut self) {
        // 목표가 놓은 데를 넘으면 그만큼 놓는다(끝으로 가기는 문서 전체를 놓는다)
        if self.scroll_target > self.layout.height - self.view_h() - 1.0 || !self.is_done() {
            let need = self.scroll_target + self.view_h() + FIRST_EXTRA;
            if self.scroll_target > 1.0e7 {
                self.ensure_all();
            } else if self.progress.y < need && !self.is_done() {
                self.more(need, None);
            }
        }
        self.clamp();
    }

    /// 목표로 한 걸음 다가간다. 아직 움직일 게 남았으면 true(타이머를 계속 돌린다).
    pub fn tick_scroll(&mut self) -> bool {
        let d = self.scroll_target - self.scroll;
        if d.abs() < 0.4 {
            self.scroll = self.scroll_target;
            return false;
        }
        // 한 프레임에 남은 거리의 30% (180ms 쯤에 닿는다)
        self.scroll += d * 0.3;
        self.ensure();
        self.clamp();
        true
    }

    pub fn animating(&self) -> bool {
        (self.scroll_target - self.scroll).abs() >= 0.4
    }

    /// id 를 가진 제목 · 각주로 간다. 원래 id · 디코드 · 인코드를 차례로 찾는다(렌더러 jumpToAnchor 와 같다).
    pub fn jump_to_anchor(&mut self, raw: &str) -> bool {
        let mut cands: Vec<String> = vec![raw.to_string()];
        if let Some(d) = md::decode_uri_component(raw) {
            cands.push(d);
        }
        cands.push(md::encode_uri_component(raw));
        for c in cands {
            // 아직 안 놓은 곳에 있을 수 있다 — 끝까지 놓고 찾는다
            if !self.anchor_y.contains_key(c.as_str()) {
                self.ensure_all();
            }
            if let Some(y) = self.anchor_y.get(c.as_str()).copied() {
                self.scroll_to_smart(y - JUMP_MARGIN);
                return true;
            }
        }
        false
    }

    /// 가까우면 부드럽게, 멀면 한 번에(먼 거리를 굴리면 도착까지 오래 걸린다 — 렌더러와 같은 규칙)
    pub fn scroll_to_smart(&mut self, y: f32) {
        let far = self.view_h() * 3.0;
        let animate = (y - self.scroll).abs() < far;
        self.scroll_to(y, animate);
    }

    // ── 찾기 대상 위치 ──────────────────────────────────────────────────────

    /// 글(ord)의 안쪽 위치 off 가 문서에서 놓인 곳(CSS px, 본문 칸 기준). 글줄의 가운데 y.
    pub fn text_point(&self, ord: u32, off: u32) -> Option<(f32, f32)> {
        let idx = *self.layout.sel.get(ord as usize)? as usize;
        let Item::Text { layout, x, y, .. } = &self.layout.items[idx] else {
            return None;
        };
        unsafe {
            let (mut px, mut py) = (0.0f32, 0.0f32);
            let mut m = DWRITE_HIT_TEST_METRICS::default();
            layout
                .HitTestTextPosition(off, false, &mut px, &mut py, &mut m)
                .ok()?;
            Some((x + px, y + py + m.height / 2.0))
        }
    }

    /// 지금 일치로 화면을 가운데 맞춘다.
    pub fn scroll_to_current_match(&mut self) {
        let Some(i) = self.find.current else { return };
        let Some(m) = self.find.matches.get(i).copied() else {
            return;
        };
        self.ensure_ord(m.ord);
        if let Some((_, y)) = self.text_point(m.ord, m.start) {
            let target = y - self.view_h() / 2.0;
            self.scroll_to_smart(target);
        }
    }

    pub fn run_find(&mut self, query: &str) {
        self.ensure_all();
        let layout = std::mem::replace(&mut self.layout, Layout::empty());
        self.find.run(&layout, query);
        self.layout = layout;
        self.scroll_to_current_match();
    }

    // ── 목차 ───────────────────────────────────────────────────────────────

    /// 제목이 하나라도 있는 문서인가(없으면 도크 대신 안내를 띄운다)
    pub fn has_headings(&self) -> bool {
        !self.doc.headings.is_empty()
    }

    /// 지금 읽는 절(doc.headings 의 번호). 아직 안 놓은 제목은 건너뛴다.
    pub fn active_heading(&self) -> Option<usize> {
        let mut found = None;
        for (i, h) in self.doc.headings.iter().enumerate() {
            let Some(y) = self.anchor_y.get(&h.id) else {
                continue;
            };
            if y - self.scroll <= READING_LINE {
                found = Some(i);
            } else {
                break;
            }
        }
        found
    }

    /// 도크의 줄들을 다시 만든다(문서 · 도크 너비가 바뀌었을 때)
    pub fn rebuild_dock(&mut self) {
        self.dock_items.clear();
        self.dock_content_h = 0.0;
        if !self.dock_open {
            return;
        }
        let inner = DOCK_W - 16.0 - SCROLLBAR;
        let mut y = 4.0;
        for (i, h) in self.doc.headings.iter().enumerate() {
            let level = h.level.min(6);
            let lv = match level {
                1 => 1.0,
                2 => 2.0,
                3 => 3.0,
                _ => 4.0,
            };
            let indent = 10.0 + (lv - 1.0) * 14.0;
            let text = if h.text.is_empty() {
                if self.ctx.korean {
                    "(제목 없음)"
                } else {
                    "(untitled)"
                }
            } else {
                h.text.as_str()
            };
            if let Some(l) = self
                .gfx
                .ui_layout_wrap(text, 14.0, level == 1, inner - indent - 10.0)
            {
                let th = unsafe {
                    let mut m = DWRITE_TEXT_METRICS::default();
                    let _ = l.GetMetrics(&mut m);
                    m.height
                };
                let item_h = th + 12.0;
                self.dock_items.push(DockItem {
                    layout: l,
                    top: y + 1.0,
                    h: item_h,
                    level,
                    heading: i,
                });
                y += item_h + 2.0;
            }
        }
        self.dock_content_h = y + 24.0;
        self.clamp_dock();
    }

    pub fn dock_list_h(&self) -> f32 {
        (self.view_h() - DOCK_HEAD_H).max(0.0)
    }

    pub fn clamp_dock(&mut self) {
        let max = (self.dock_content_h - self.dock_list_h()).max(0.0);
        self.dock_scroll = self.dock_scroll.clamp(0.0, max);
    }

    /// 도크에서 y(CSS px, 클라이언트 위쪽 기준)에 있는 줄
    pub fn dock_item_at(&self, y: f32) -> Option<usize> {
        let ly = y - DOCK_HEAD_H + self.dock_scroll;
        self.dock_items
            .iter()
            .position(|it| ly >= it.top && ly < it.top + it.h)
    }

    pub fn jump_to_heading(&mut self, heading: usize) {
        let Some(h) = self.doc.headings.get(heading) else {
            return;
        };
        let id = h.id.to_string();
        if id.is_empty() {
            return;
        }
        self.jump_to_anchor(&id);
    }

    /// 지금 읽는 절이 도크 밖으로 나가지 않게 따라간다.
    pub fn follow_active_in_dock(&mut self) {
        let Some(a) = self.active_heading() else {
            return;
        };
        let Some(it) = self.dock_items.iter().find(|d| d.heading == a) else {
            return;
        };
        let (top, bottom) = (it.top, it.top + it.h);
        let h = self.dock_list_h();
        if top < self.dock_scroll {
            self.dock_scroll = top - 4.0;
        } else if bottom > self.dock_scroll + h {
            self.dock_scroll = bottom - h + 4.0;
        }
        self.clamp_dock();
    }

    // ── 원문 보기 · 앞머리 ──────────────────────────────────────────────────

    /// 원문 보기 ↔ 서식 보기. 읽던 자리를 지킨다(.txt 는 처음부터 원문이므로 거꾸로 서식을 입혀 본다).
    pub fn set_plain_view(&mut self, on: bool) {
        if self.plain_view == on {
            return;
        }
        self.plain_view = on;
        let keep = self.scroll;
        self.reparse();
        self.scroll = keep;
        self.scroll_target = keep;
        self.clamp();
    }

    pub fn reparse(&mut self) {
        self.doc = if self.plain_view {
            md::parse_plain(&self.src)
        } else {
            md::parse(&self.src)
        };
        self.sel = None;
        self.find.clear();
        self.relayout();
        self.clamp();
    }

    /// 앞머리를 눌러 펴고 접는다.
    pub fn toggle_front_matter(&mut self) {
        self.ctx.fm_open = !self.ctx.fm_open;
        let keep = self.scroll;
        self.relayout();
        self.scroll = keep;
        self.clamp();
    }

    /// 눌린 자리의 그림이 링크(`[![](그림)](주소)`)이면 그 주소. px · py 는 클라이언트 물리 px.
    pub fn image_href_at(&self, px: f32, py: f32) -> Option<Arc<str>> {
        let s = self.scale();
        let (dx, dy) = (px / s - self.col_x, py / s + self.scroll);
        for it in &self.layout.items {
            if let Item::Image(i) = it {
                if dx >= i.x && dx < i.x + i.w && dy >= i.y && dy < i.y + i.h {
                    return i.href.clone();
                }
            }
        }
        None
    }

    /// (스크롤 위치를 반영한) 눌린 자리의 앞머리 토글인가. px · py 는 클라이언트 물리 px.
    pub fn hot_at(&self, px: f32, py: f32) -> Option<Hot> {
        let s = self.scale();
        let (dx, dy) = (px / s - self.col_x, py / s + self.scroll);
        self.layout
            .hots
            .iter()
            .find(|(_, r)| dx >= r[0] && dx < r[2] && dy >= r[1] && dy < r[3])
            .map(|(h, _)| *h)
    }
}

/// 도크 머리(제목 줄)의 높이 — 14px 위 여백 + 34px 단추 + 8px 아래 여백
pub const DOCK_HEAD_H: f32 = 56.0;

impl Gfx {
    /// 여러 줄로 접히는 UI 글(목차 도크). 어절 안에서도 끊는다(overflow-wrap: anywhere).
    pub fn ui_layout_wrap(
        &self,
        text: &str,
        size: f32,
        bold: bool,
        max_w: f32,
    ) -> Option<IDWriteTextLayout> {
        let l = self.ui_layout(text, size, bold, max_w.max(20.0), 1.0e5)?;
        unsafe {
            let _ = l.SetWordWrapping(DWRITE_WORD_WRAPPING_EMERGENCY_BREAK);
            // 줄 높이 1.45
            let _ = l.SetLineSpacing(
                DWRITE_LINE_SPACING_METHOD_UNIFORM,
                size * 1.45,
                size * 1.45 * 0.8,
            );
        }
        Some(l)
    }
}
