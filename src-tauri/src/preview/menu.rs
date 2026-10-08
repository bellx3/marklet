//! 우클릭 · 더 보기(⋮) 메뉴 — 윈도우 기본 팝업 메뉴(`TrackPopupMenu`) 대신 창 안에 직접 그린다.
//!
//! 웹 창의 메뉴(src/desktop/popup-menu.ts · desktop.css 의 `.mk-menu`)와 같은 모양이다: 둥근 상자 · 반전색 강조 · 오른쪽에 흐린 단축키 · 구분선.
//! 기본 팝업 메뉴는 OS 의 것처럼 보여서 이게 Marklet 의 기능인지 헷갈리고, 모양을 정할 수도 없다(그래서 웹 창은 처음부터 직접 그렸다).
//! 창 안에 그리므로 창 밖으로 나가지 못한다 — 웹 창과 같고, 자리는 창 안으로 눌러 넣는다.
//!
//! 여기는 **무엇을 · 어디에 · 어느 순서로**만 안다(순수한 계산이라 시험이 된다). 그리는 것은 paint.rs, 마우스 · 키보드는 window.rs 가 맡는다.
//! 숫자는 CSS px 이고 값은 desktop.css 의 `.mk-menu*` 를 따른다.

use windows::Win32::Graphics::DirectWrite::{IDWriteTextLayout, DWRITE_TEXT_METRICS};

use super::layout::Gfx;
use crate::strings::Strings;

// ── 모양(desktop.css `.mk-menu` · `.mk-menu-item` · `.mk-menu-sep`) ──────────────

/// 상자의 최소 너비(테두리 · 안쪽 여백 포함)
pub const MIN_W: f32 = 232.0;
/// 상자 안쪽 여백
pub const PAD: f32 = 6.0;
pub const BORDER: f32 = 1.0;
/// 항목 높이: 위아래 여백 9 + 줄 16.2 를 정수로 맞춘 것(강조 상자의 가장자리가 뭉개지지 않게)
pub const ITEM_H: f32 = 34.0;
/// 구분선 하나가 차지하는 높이: 선 1 + 위아래 5
pub const SEP_H: f32 = 11.0;
/// 구분선의 좌우 들여쓰기
pub const SEP_INSET: f32 = 8.0;
/// 항목 안쪽 좌우 여백
pub const SIDE: f32 = 12.0;
/// 이름과 단축키 사이 최소 간격
pub const GAP: f32 = 28.0;
/// 창 가장자리에서 떨어뜨릴 거리
pub const EDGE: f32 = 8.0;
/// 단추 아래에 열 때 단추와의 간격
pub const BELOW_GAP: f32 = 6.0;
pub const RADIUS: f32 = 12.0;
pub const ITEM_RADIUS: f32 = 8.0;
pub const LABEL_PX: f32 = 13.5;
pub const KEY_PX: f32 = 12.0;
/// 그림자(`--shadow-2`: 0 8px 28px)
pub const SHADOW_DY: f32 = 8.0;
pub const SHADOW_BLUR: f32 = 28.0;

// ── 내용 ──────────────────────────────────────────────────────────────────────

/// 메뉴가 하는 일
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Act {
    Copy,
    SelectAll,
    Edit,
    Toc,
    Find,
    Source,
    Open,
    Print,
    Pdf,
}

pub struct Item {
    pub act: Act,
    pub label: &'static str,
    /// 오른쪽에 흐리게 적는 단축키
    pub key: &'static str,
    pub enabled: bool,
}

pub enum Entry {
    Item(Item),
    Sep,
}

impl Entry {
    fn enabled_item(&self) -> bool {
        matches!(self, Entry::Item(i) if i.enabled)
    }
}

/// 메뉴의 항목들. 웹 창의 `menuEntries()`(src/desktop/main.ts)와 같은 순서 · 같은 단축키다 — 메뉴가 단축키 사전이 된다.
/// @param has_selection 고른 글이 있으면 맨 위에 복사가 붙는다
/// @param has_toc       목차를 열 수 있는가(제목이 있거나 이미 열려 있다). 아니면 흐리게 둔다.
pub fn entries(tr: &Strings, has_selection: bool, has_toc: bool) -> Vec<Entry> {
    let item = |act, label, key, enabled| {
        Entry::Item(Item {
            act,
            label,
            key,
            enabled,
        })
    };
    let mut v = Vec::new();
    if has_selection {
        v.push(item(Act::Copy, tr.copy, "Ctrl+C", true));
    }
    v.push(item(Act::SelectAll, tr.select_all, "Ctrl+A", true));
    v.push(Entry::Sep);
    v.push(item(Act::Edit, tr.edit, "Ctrl+E", true));
    v.push(item(Act::Toc, tr.menu_toc, "Ctrl+T", has_toc));
    v.push(item(Act::Find, tr.menu_find, "Ctrl+F", true));
    v.push(item(Act::Source, tr.menu_source, "Ctrl+U", true));
    v.push(Entry::Sep);
    v.push(item(Act::Open, tr.open, "Ctrl+O", true));
    v.push(item(Act::Print, tr.print, "Ctrl+P", true));
    v.push(item(Act::Pdf, tr.export_pdf, "Ctrl+Shift+P", true));
    v
}

// ── 자리 ──────────────────────────────────────────────────────────────────────

/// 메뉴를 어디에 여는가
#[derive(Clone, Copy, Debug)]
pub enum At {
    /// 마우스 자리(클라이언트 기준 CSS px)
    Point(f32, f32),
    /// 단추 아래 — 단추의 오른쪽 끝에 상자의 오른쪽 끝을 맞춘다
    Below { right: f32, bottom: f32 },
}

pub struct Geo {
    /// 상자(테두리 포함). 클라이언트 기준 CSS px: [왼쪽, 위, 오른쪽, 아래]
    pub rect: [f32; 4],
    /// 항목 · 구분선마다의 자리(`entries` 와 같은 순서). 가로는 상자 안쪽 전체다.
    pub rows: Vec<[f32; 4]>,
}

impl Geo {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.rect[0] && x < self.rect[2] && y >= self.rect[1] && y < self.rect[3]
    }

    /// 이 점 아래의 줄(항목 · 구분선). 여백이나 상자 밖이면 None.
    pub fn row_at(&self, x: f32, y: f32) -> Option<usize> {
        self.rows
            .iter()
            .position(|r| x >= r[0] && x < r[2] && y >= r[1] && y < r[3])
    }
}

/// 상자의 크기와 자리를 정한다.
/// @param widths 항목마다 (이름 너비, 단축키 너비) — 구분선은 (0, 0). `entries` 와 같은 순서.
/// @param win    창 안쪽 크기(CSS px). 상자는 가장자리에서 `EDGE` 만큼 안으로 눌린다(웹 메뉴와 같다).
pub fn layout(entries: &[Entry], widths: &[(f32, f32)], at: At, win: (f32, f32)) -> Geo {
    let chrome = 2.0 * (BORDER + PAD);
    let mut need = 0.0f32;
    let mut h = chrome;
    for (e, &(label_w, key_w)) in entries.iter().zip(widths) {
        match e {
            Entry::Item(_) => {
                let gap = if key_w > 0.0 { GAP + key_w } else { 0.0 };
                need = need.max(2.0 * SIDE + label_w + gap);
                h += ITEM_H;
            }
            Entry::Sep => h += SEP_H,
        }
    }
    let w = MIN_W.max(chrome + need);
    let (x, y) = match at {
        At::Point(x, y) => (x, y),
        At::Below { right, bottom } => (right - w, bottom + BELOW_GAP),
    };
    // 화면 안으로(웹의 `Math.max(EDGE, Math.min(x, innerWidth - w - EDGE))`). 창이 메뉴보다 작으면 가장자리에 붙는다.
    let x = x.min(win.0 - w - EDGE).max(EDGE);
    let y = y.min(win.1 - h - EDGE).max(EDGE);

    let left = x + BORDER + PAD;
    let right = x + w - BORDER - PAD;
    let mut top = y + BORDER + PAD;
    let rows = entries
        .iter()
        .map(|e| {
            let rh = if matches!(e, Entry::Sep) {
                SEP_H
            } else {
                ITEM_H
            };
            let r = [left, top, right, top + rh];
            top += rh;
            r
        })
        .collect();
    Geo {
        rect: [x, y, x + w, y + h],
        rows,
    }
}

// ── 키보드 ────────────────────────────────────────────────────────────────────

pub fn first_enabled(entries: &[Entry]) -> Option<usize> {
    entries.iter().position(Entry::enabled_item)
}

pub fn last_enabled(entries: &[Entry]) -> Option<usize> {
    entries.iter().rposition(Entry::enabled_item)
}

/// 방향키로 옮긴다(`dir`: 1 아래, -1 위). 구분선과 흐린 항목은 건너뛰고, 끝에서 넘어가면 반대편으로 돈다.
/// 아무것도 강조되지 않았을 때는 아래가 첫 항목, 위가 끝 항목이다(웹 메뉴와 같다).
pub fn step(entries: &[Entry], hot: Option<usize>, dir: i32) -> Option<usize> {
    let n = entries.len();
    if n == 0 {
        return None;
    }
    let mut i = match hot {
        Some(i) => i,
        None if dir > 0 => n - 1,
        None => 0,
    };
    for _ in 0..n {
        i = if dir > 0 {
            (i + 1) % n
        } else {
            (i + n - 1) % n
        };
        if entries[i].enabled_item() {
            return Some(i);
        }
    }
    hot
}

// ── 그림자 ────────────────────────────────────────────────────────────────────

/// 표준정규분포의 누적분포(Φ). 그림자의 번짐(가우스)을 겹친 층으로 어림할 때 쓴다.
pub fn phi(x: f32) -> f32 {
    // Abramowitz-Stegun 7.1.26 (오차 1.5e-7)
    let z = x.abs() / std::f32::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.327_591_1 * z);
    let poly = t
        * (0.254_829_6
            + t * (-0.284_496_74 + t * (1.421_413_8 + t * (-1.453_152_1 + t * 1.061_405_4))));
    let erf = 1.0 - poly * (-z * z).exp();
    0.5 * (1.0 + if x >= 0.0 { erf } else { -erf })
}

// ── 열려 있는 메뉴 ────────────────────────────────────────────────────────────

pub struct Popup {
    pub entries: Vec<Entry>,
    pub geo: Geo,
    /// 강조된 항목(마우스를 올렸거나 키로 옮긴 것). 열 때는 없다 — 마우스로 열었는데 선택이 미리 걸려 보이면 안 된다.
    pub hot: Option<usize>,
    /// 마우스를 누른 항목(뗄 때 같은 항목 위여야 실행한다)
    pub pressed: Option<usize>,
    pub labels: Vec<Option<IDWriteTextLayout>>,
    pub keys: Vec<Option<IDWriteTextLayout>>,
    /// 글 상자 크기(세로 가운데를 맞추는 데 쓴다)
    pub label_size: Vec<(f32, f32)>,
    pub key_size: Vec<(f32, f32)>,
}

fn measure(l: &IDWriteTextLayout) -> (f32, f32) {
    let mut m = DWRITE_TEXT_METRICS::default();
    unsafe {
        let _ = l.GetMetrics(&mut m);
    }
    (m.width, m.height)
}

impl Popup {
    pub fn new(gfx: &Gfx, entries: Vec<Entry>, at: At, win: (f32, f32)) -> Popup {
        let (mut labels, mut keys) = (Vec::new(), Vec::new());
        let (mut label_size, mut key_size) = (Vec::new(), Vec::new());
        for e in &entries {
            let (l, k) = match e {
                Entry::Item(it) => (
                    gfx.ui_layout(it.label, LABEL_PX, false, 400.0, 24.0),
                    if it.key.is_empty() {
                        None
                    } else {
                        gfx.ui_layout(it.key, KEY_PX, false, 200.0, 24.0)
                    },
                ),
                Entry::Sep => (None, None),
            };
            label_size.push(l.as_ref().map(measure).unwrap_or((0.0, 0.0)));
            key_size.push(k.as_ref().map(measure).unwrap_or((0.0, 0.0)));
            labels.push(l);
            keys.push(k);
        }
        let widths: Vec<(f32, f32)> = label_size
            .iter()
            .zip(&key_size)
            .map(|(l, k)| (l.0, k.0))
            .collect();
        let geo = layout(&entries, &widths, at, win);
        Popup {
            entries,
            geo,
            hot: None,
            pressed: None,
            labels,
            keys,
            label_size,
            key_size,
        }
    }

    /// 이 점 아래의 항목(구분선 · 여백이면 None). 흐린 항목도 돌려준다 — 걸러 쓰는 쪽이 정한다.
    pub fn item_at(&self, x: f32, y: f32) -> Option<usize> {
        let i = self.geo.row_at(x, y)?;
        matches!(self.entries[i], Entry::Item(_)).then_some(i)
    }

    /// 이 줄이 누를 수 있는 항목이면 그 일
    pub fn act_at(&self, i: usize) -> Option<Act> {
        match self.entries.get(i) {
            Some(Entry::Item(it)) if it.enabled => Some(it.act),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings::{EN, KO};

    fn item(act: Act, enabled: bool) -> Entry {
        Entry::Item(Item {
            act,
            label: "x",
            key: "",
            enabled,
        })
    }
    /// 이름 너비 80 · 단축키 너비 40 인 항목들과 구분선
    fn sample() -> (Vec<Entry>, Vec<(f32, f32)>) {
        let e = vec![
            item(Act::SelectAll, true),
            Entry::Sep,
            item(Act::Edit, true),
            item(Act::Toc, false),
            item(Act::Find, true),
            Entry::Sep,
            item(Act::Open, true),
        ];
        let w = e
            .iter()
            .map(|x| {
                if matches!(x, Entry::Sep) {
                    (0.0, 0.0)
                } else {
                    (80.0, 40.0)
                }
            })
            .collect();
        (e, w)
    }
    const WIN: (f32, f32) = (980.0, 800.0);

    fn acts(v: &[Entry]) -> Vec<Option<Act>> {
        v.iter()
            .map(|e| match e {
                Entry::Item(i) => Some(i.act),
                Entry::Sep => None,
            })
            .collect()
    }

    #[test]
    fn entries_follow_the_web_menu() {
        let v = entries(&KO, true, true);
        assert_eq!(
            acts(&v),
            vec![
                Some(Act::Copy),
                Some(Act::SelectAll),
                None,
                Some(Act::Edit),
                Some(Act::Toc),
                Some(Act::Find),
                Some(Act::Source),
                None,
                Some(Act::Open),
                Some(Act::Print),
                Some(Act::Pdf),
            ]
        );
        // 고른 글이 없으면 복사가 없다
        let v = entries(&KO, false, true);
        assert_eq!(acts(&v)[0], Some(Act::SelectAll));
        assert_eq!(v.len(), 10);
        // 단축키와 글(웹 창의 src/i18n 과 같다)
        let keys: Vec<&str> = v
            .iter()
            .filter_map(|e| match e {
                Entry::Item(i) => Some(i.key),
                _ => None,
            })
            .collect();
        assert_eq!(
            keys,
            [
                "Ctrl+A",
                "Ctrl+E",
                "Ctrl+T",
                "Ctrl+F",
                "Ctrl+U",
                "Ctrl+O",
                "Ctrl+P",
                "Ctrl+Shift+P"
            ]
        );
        let labels: Vec<&str> = v
            .iter()
            .filter_map(|e| match e {
                Entry::Item(i) => Some(i.label),
                _ => None,
            })
            .collect();
        assert_eq!(
            labels,
            [
                "모두 선택",
                "편집",
                "목차",
                "문서에서 찾기",
                "원문 보기",
                "열기…",
                "인쇄…",
                "PDF로 내보내기…"
            ]
        );
        let en: Vec<&str> = entries(&EN, true, true)
            .iter()
            .filter_map(|e| match e {
                Entry::Item(i) => Some(i.label),
                _ => None,
            })
            .collect();
        assert_eq!(en[0], "Copy");
        assert_eq!(en[3], "Table of contents");
        assert_eq!(en[4], "Find in document");
        assert_eq!(en[5], "Show source");
        assert_eq!(en[7], "Print…");
        assert_eq!(en[8], "Export as PDF…");
    }

    #[test]
    fn the_toc_is_dimmed_without_headings() {
        let v = entries(&KO, false, false);
        let toc = v
            .iter()
            .find_map(|e| match e {
                Entry::Item(i) if i.act == Act::Toc => Some(i.enabled),
                _ => None,
            })
            .unwrap();
        assert!(!toc);
    }

    #[test]
    fn width_has_a_floor_and_grows_with_long_text() {
        let (e, w) = sample();
        let g = layout(&e, &w, At::Point(100.0, 100.0), WIN);
        assert_eq!(g.rect[2] - g.rect[0], MIN_W);
        // 이름 200 + 간격 28 + 단축키 90 + 항목 여백 24 + 상자 여백 14
        let mut wide = w.clone();
        wide[2] = (200.0, 90.0);
        let g = layout(&e, &wide, At::Point(100.0, 100.0), WIN);
        assert_eq!(g.rect[2] - g.rect[0], 14.0 + 24.0 + 200.0 + GAP + 90.0);
        // 단축키가 없는 항목은 간격을 더하지 않는다
        let mut nokey = w.clone();
        nokey[0] = (250.0, 0.0);
        let g = layout(&e, &nokey, At::Point(100.0, 100.0), WIN);
        assert_eq!(g.rect[2] - g.rect[0], 14.0 + 24.0 + 250.0);
    }

    #[test]
    fn height_adds_up_and_rows_tile_inside_the_box() {
        let (e, w) = sample();
        let g = layout(&e, &w, At::Point(100.0, 100.0), WIN);
        assert_eq!(g.rect[3] - g.rect[1], 14.0 + 5.0 * ITEM_H + 2.0 * SEP_H);
        assert_eq!(g.rows.len(), e.len());
        // 줄이 틈 없이 이어지고, 첫 줄은 테두리 + 여백 안쪽에서 시작한다
        assert_eq!(g.rows[0][1], g.rect[1] + BORDER + PAD);
        for pair in g.rows.windows(2) {
            assert_eq!(pair[0][3], pair[1][1]);
        }
        let last = g.rows.last().unwrap();
        assert_eq!(last[3], g.rect[3] - BORDER - PAD);
        for r in &g.rows {
            assert_eq!(r[0], g.rect[0] + BORDER + PAD);
            assert_eq!(r[2], g.rect[2] - BORDER - PAD);
        }
        assert_eq!(g.rows[1][3] - g.rows[1][1], SEP_H);
        assert_eq!(g.rows[0][3] - g.rows[0][1], ITEM_H);
    }

    #[test]
    fn a_point_menu_opens_at_the_point() {
        let (e, w) = sample();
        let g = layout(&e, &w, At::Point(300.0, 200.0), WIN);
        assert_eq!((g.rect[0], g.rect[1]), (300.0, 200.0));
    }

    #[test]
    fn a_menu_is_pressed_back_into_the_window() {
        let (e, w) = sample();
        let h = 14.0 + 5.0 * ITEM_H + 2.0 * SEP_H;
        // 오른쪽 · 아래로 넘치면 가장자리에서 EDGE 만큼 안으로
        let g = layout(&e, &w, At::Point(970.0, 790.0), WIN);
        assert_eq!(g.rect[2], WIN.0 - EDGE);
        assert_eq!(g.rect[3], WIN.1 - EDGE);
        assert_eq!(g.rect[3] - g.rect[1], h);
        // 왼쪽 · 위로 나가면 EDGE
        let g = layout(&e, &w, At::Point(-50.0, -50.0), WIN);
        assert_eq!((g.rect[0], g.rect[1]), (EDGE, EDGE));
        // 창이 메뉴보다 작으면 가장자리에 붙고 아래는 잘린다(웹 메뉴와 같다)
        let g = layout(&e, &w, At::Point(100.0, 100.0), (200.0, 100.0));
        assert_eq!((g.rect[0], g.rect[1]), (EDGE, EDGE));
    }

    #[test]
    fn a_menu_under_a_button_is_right_aligned_and_six_below() {
        let (e, w) = sample();
        let g = layout(
            &e,
            &w,
            At::Below {
                right: 900.0,
                bottom: 51.0,
            },
            WIN,
        );
        assert_eq!(g.rect[2], 900.0);
        assert_eq!(g.rect[1], 51.0 + BELOW_GAP);
        // 단추가 왼쪽 끝에 있어 상자가 창 밖으로 나가면 안으로 눌린다
        let g = layout(
            &e,
            &w,
            At::Below {
                right: 100.0,
                bottom: 51.0,
            },
            WIN,
        );
        assert_eq!(g.rect[0], EDGE);
    }

    #[test]
    fn hit_testing_finds_items_but_not_separators_or_padding() {
        let (e, w) = sample();
        let g = layout(&e, &w, At::Point(100.0, 100.0), WIN);
        let mid = |r: &[f32; 4]| ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
        for (i, r) in g.rows.iter().enumerate() {
            let (x, y) = mid(r);
            assert_eq!(g.row_at(x, y), Some(i));
        }
        // 상자 안쪽 여백과 테두리는 어느 줄도 아니지만 상자에는 든다
        let (x, y) = (g.rect[0] + 2.0, g.rows[0][1] + 5.0);
        assert!(g.contains(x, y));
        assert_eq!(g.row_at(x, y), None);
        assert!(g.contains(g.rect[0], g.rect[1]));
        assert!(!g.contains(g.rect[2], g.rect[3]));
        assert!(!g.contains(g.rect[0] - 0.5, g.rect[1] + 20.0));
    }

    #[test]
    fn arrow_keys_skip_separators_and_dimmed_items_and_wrap() {
        let (e, _) = sample();
        // [0]모두 선택 [1]── [2]편집 [3]목차(흐림) [4]찾기 [5]── [6]열기
        assert_eq!(first_enabled(&e), Some(0));
        assert_eq!(last_enabled(&e), Some(6));
        // 아무것도 없을 때: 아래는 첫 항목, 위는 끝 항목
        assert_eq!(step(&e, None, 1), Some(0));
        assert_eq!(step(&e, None, -1), Some(6));
        // 아래로: 구분선과 흐린 항목을 건너뛴다
        assert_eq!(step(&e, Some(0), 1), Some(2));
        assert_eq!(step(&e, Some(2), 1), Some(4));
        assert_eq!(step(&e, Some(4), 1), Some(6));
        // 끝에서 돈다
        assert_eq!(step(&e, Some(6), 1), Some(0));
        assert_eq!(step(&e, Some(0), -1), Some(6));
        assert_eq!(step(&e, Some(6), -1), Some(4));
        assert_eq!(step(&e, Some(4), -1), Some(2));
        // 누를 수 있는 항목이 하나도 없으면 그대로
        let none = vec![Entry::Sep, item(Act::Edit, false)];
        assert_eq!(first_enabled(&none), None);
        assert_eq!(step(&none, None, 1), None);
        assert_eq!(step(&none, Some(1), 1), Some(1));
        assert_eq!(step(&[], None, 1), None);
    }

    #[test]
    fn the_shadow_falloff_is_a_normal_cdf() {
        assert!((phi(0.0) - 0.5).abs() < 1e-6);
        assert!((phi(1.0) - 0.841_344_7).abs() < 1e-5);
        assert!((phi(2.0) - 0.977_249_9).abs() < 1e-5);
        assert!((phi(-1.0) - 0.158_655_3).abs() < 1e-5);
        assert!(phi(-8.0) >= 0.0 && phi(8.0) <= 1.0);
    }
}
