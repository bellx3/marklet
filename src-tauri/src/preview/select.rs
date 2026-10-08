//! 글자 고르기 — 누른 자리에서 글자를 찾고(hit test), 고른 글을 문자열로 만든다.
//!
//! 고른 자리는 (읽는 순서 번호, 글 안의 UTF-16 위치)다. 배치가 다시 놓여도(창 크기 · 확대) 같은 글을 가리킨다.

use windows::core::BOOL;
use windows::Win32::Graphics::DirectWrite::DWRITE_HIT_TEST_METRICS;

use super::layout::Item;
use super::view::{Hit, Pos, Selection, View};

/// 낱말을 이루는 글자(영숫자 · 밑줄 · 한글, 그리고 어절을 끊지 않으려고 끼운 U+2060)
fn is_word(c: u16) -> bool {
    if c == 0x2060 || c == b'_' as u16 {
        return true;
    }
    char::from_u32(c as u32)
        .map(|c| c.is_alphanumeric())
        .unwrap_or(false)
}

/// off 가 놓인 낱말의 [시작, 끝). 낱말 글자가 아니면 그 글자 하나(공백이면 공백 덩어리).
pub fn word_range(text: &[u16], off: u32) -> (u32, u32) {
    let n = text.len();
    if n == 0 {
        return (0, 0);
    }
    let i = (off as usize).min(n - 1);
    let (mut a, mut b) = (i, i + 1);
    if is_word(text[i]) {
        while a > 0 && is_word(text[a - 1]) {
            a -= 1;
        }
        while b < n && is_word(text[b]) {
            b += 1;
        }
    } else if (0xd800..0xdc00).contains(&text[i]) {
        // 서로게이트 쌍(이모지)은 두 칸이 한 글자다
        b = (i + 2).min(n);
    } else if text[i] == b' ' as u16 || text[i] == b'\t' as u16 {
        while a > 0 && (text[a - 1] == b' ' as u16 || text[a - 1] == b'\t' as u16) {
            a -= 1;
        }
        while b < n && (text[b] == b' ' as u16 || text[b] == b'\t' as u16) {
            b += 1;
        }
    }
    (a as u32, b as u32)
}

impl View {
    /// 클라이언트 물리 px (px, py) 에서 가장 가까운 글자. 글이 하나도 없으면 None.
    pub fn hit_test(&self, px: f32, py: f32) -> Option<Hit> {
        let s = self.scale();
        let dx = px / s - self.col_x;
        let dy = py / s + self.scroll;
        let sel = &self.layout.sel;
        let n = sel.len();
        if n == 0 {
            return None;
        }
        let top_of = |k: usize| -> f32 {
            match &self.layout.items[sel[k] as usize] {
                Item::Text { y, .. } => *y,
                _ => 0.0,
            }
        };
        // 글은 읽는 순서로 위에서 아래다 — 눌린 높이 바로 아래에서 시작하는 글을 이분 탐색으로 찾는다
        let (mut lo, mut hi) = (0usize, n);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if top_of(mid) <= dy {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let first = lo.saturating_sub(48);
        let last = (lo + 2).min(n);
        let mut best: Option<(f32, usize)> = None;
        for (ord, &item) in sel.iter().enumerate().take(last).skip(first) {
            if let Item::Text {
                x,
                y,
                h,
                clip,
                meta: Some(m),
                ..
            } = &self.layout.items[item as usize]
            {
                let (x0, x1) = match clip {
                    Some(c) => (c[0], c[2]),
                    None => (*x, *x + m.content_w.max(1.0)),
                };
                let dv = if dy < *y {
                    *y - dy
                } else if dy > *y + *h {
                    dy - (*y + *h)
                } else {
                    0.0
                };
                let dh = if dx < x0 {
                    x0 - dx
                } else if dx > x1 {
                    dx - x1
                } else {
                    0.0
                };
                // 세로가 먼저다(같은 줄의 옆 칸보다 다른 줄이 더 멀다)
                let score = dv * 1000.0 + dh;
                if best.map(|b| score < b.0).unwrap_or(true) {
                    best = Some((score, ord));
                }
            }
        }
        let (score, ord) = best?;
        let Item::Text {
            layout,
            x,
            y,
            clip,
            meta: Some(m),
            ..
        } = &self.layout.items[sel[ord] as usize]
        else {
            return None;
        };
        let hscroll = if clip.is_some() { m.hscroll.get() } else { 0.0 };
        let (lx, ly) = (dx - x + hscroll, dy - y);
        unsafe {
            let (mut trailing, mut inside) = (BOOL(0), BOOL(0));
            let mut mt = DWRITE_HIT_TEST_METRICS::default();
            layout
                .HitTestPoint(lx, ly, &mut trailing, &mut inside, &mut mt)
                .ok()?;
            let off = (mt.textPosition + if trailing.as_bool() { mt.length } else { 0 })
                .min(m.text.len() as u32);
            let on_text = inside.as_bool() && score == 0.0;
            let link = if on_text {
                m.links
                    .iter()
                    .find(|l| l.start <= mt.textPosition && mt.textPosition < l.end)
                    .map(|l| l.href.clone())
            } else {
                None
            };
            Some(Hit {
                pos: Pos {
                    ord: ord as u32,
                    off,
                },
                inside: on_text,
                link,
            })
        }
    }

    pub fn text_of(&self, ord: u32) -> Option<&[u16]> {
        let idx = *self.layout.sel.get(ord as usize)? as usize;
        match &self.layout.items[idx] {
            Item::Text { meta: Some(m), .. } => Some(&m.text),
            _ => None,
        }
    }

    /// 고른 글. 어절을 끊지 않으려고 끼운 U+2060 은 뺀다. 다른 글로 넘어갈 때는 글마다 정해진 구분(줄바꿈 · 탭)을 붙인다.
    pub fn selected_text(&mut self) -> String {
        let Some(sel) = self.sel else {
            return String::new();
        };
        if sel.is_empty() {
            return String::new();
        }
        let (a, b) = sel.ordered();
        self.ensure_ord(b.ord);
        let mut out = String::new();
        for ord in a.ord..=b.ord {
            let Some(&idx) = self.layout.sel.get(ord as usize) else {
                break;
            };
            let Item::Text { meta: Some(m), .. } = &self.layout.items[idx as usize] else {
                continue;
            };
            let from = if ord == a.ord { a.off as usize } else { 0 };
            let to = if ord == b.ord {
                (b.off as usize).min(m.text.len())
            } else {
                m.text.len()
            };
            let slice = &m.text[from.min(to)..to];
            out.extend(
                char::decode_utf16(slice.iter().copied())
                    .map(|r| r.unwrap_or('\u{fffd}'))
                    .filter(|c| *c != '\u{2060}'),
            );
            if ord != b.ord {
                out.push_str(m.sep.text());
            }
        }
        out
    }

    pub fn has_selection(&self) -> bool {
        self.sel.map(|s| !s.is_empty()).unwrap_or(false)
    }

    pub fn select_all(&mut self) {
        self.ensure_all();
        let n = self.layout.sel.len();
        if n == 0 {
            return;
        }
        let last = (n - 1) as u32;
        let len = self.text_of(last).map(|t| t.len() as u32).unwrap_or(0);
        self.sel = Some(Selection {
            anchor: Pos { ord: 0, off: 0 },
            focus: Pos {
                ord: last,
                off: len,
            },
        });
    }

    /// 누른 글의 낱말을 고른다(더블클릭)
    pub fn select_word_at(&mut self, pos: Pos) {
        let Some(t) = self.text_of(pos.ord) else {
            return;
        };
        let (a, b) = word_range(t, pos.off);
        self.sel = Some(Selection {
            anchor: Pos {
                ord: pos.ord,
                off: a,
            },
            focus: Pos {
                ord: pos.ord,
                off: b,
            },
        });
    }

    /// 누른 글 전체를 고른다(트리플클릭)
    pub fn select_text_at(&mut self, pos: Pos) {
        let Some(t) = self.text_of(pos.ord) else {
            return;
        };
        let len = t.len() as u32;
        self.sel = Some(Selection {
            anchor: Pos {
                ord: pos.ord,
                off: 0,
            },
            focus: Pos {
                ord: pos.ord,
                off: len,
            },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::layout::tests::{harness, lay};
    use super::super::layout::{Ctx, Layout};
    use super::super::md;
    use super::super::view::View;
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn words_are_runs_of_letters_and_digits() {
        let t = u("Hello, 마크다운_뷰어 x");
        assert_eq!(word_range(&t, 2), (0, 5)); // Hello
        assert_eq!(word_range(&t, 5), (5, 6)); // ,
        assert_eq!(word_range(&t, 8), (7, 14)); // 마크다운_뷰어
        assert_eq!(word_range(&t, 6), (6, 7)); // 공백 하나
        assert_eq!(word_range(&[], 0), (0, 0));
        // 이모지는 두 칸이 한 글자
        let e = u("a😀b");
        assert_eq!(word_range(&e, 1), (1, 3));
    }

    /// 창 없이 만든 View. 폭 800 · 높이 600 CSS px.
    fn view(src: &str) -> Option<View> {
        let g = harness()?;
        let (gfx, brushes) = g;
        let doc = md::parse(src);
        let mut v = View::new(
            gfx,
            brushes,
            doc,
            std::sync::Arc::new(src.to_string()),
            Ctx::plain(),
        );
        v.dpi = 1.0;
        v.cw = 800;
        v.ch = 600;
        v.relayout();
        v.ensure_all();
        Some(v)
    }

    #[test]
    fn selecting_all_copies_every_text_with_its_separators() {
        let Some(mut v) =
            view("# 제목\n\n첫째 문단입니다.\n\n- 하나\n- 둘\n\n| a | b |\n| - | - |\n| 1 | 2 |\n")
        else {
            return;
        };
        v.select_all();
        let t = v.selected_text();
        assert!(
            t.starts_with("제목\n\n첫째 문단입니다.\n\n하나\n둘"),
            "{t:?}"
        );
        // 표: 칸은 탭, 줄은 줄바꿈
        assert!(t.contains("a\tb\n1\t2"), "{t:?}");
        assert!(!t.contains('\u{2060}'));
    }

    #[test]
    fn a_partial_selection_inside_one_paragraph() {
        let Some(mut v) = view("가나다라마바사\n") else {
            return;
        };
        v.sel = Some(Selection {
            anchor: Pos { ord: 0, off: 4 },
            focus: Pos { ord: 0, off: 1 },
        });
        // 앵커가 뒤여도 같은 범위다(WJ 가 끼어 있어 자리가 어긋나지만 글자만 나온다)
        let t = v.selected_text();
        assert!(!t.is_empty() && !t.contains('\u{2060}'));
        assert!("가나다라마바사".contains(&t), "{t:?}");
    }

    #[test]
    fn hit_test_finds_the_text_under_the_point_and_its_link() {
        let Some(v) = view("앞 글 [링크 글](https://a.example) 뒤\n\n둘째 문단\n") else {
            return;
        };
        let s = v.scale();
        // 첫 글의 위치를 알아내려고 배치에서 y 를 읽는다
        let (x, y) = match &v.layout.items[0] {
            Item::Text { x, y, .. } => (*x, *y),
            other => {
                let _ = other;
                return;
            }
        };
        let px = (x + v.col_x + 2.0) * s;
        let py = (y + 10.0 - v.scroll) * s;
        let h = v.hit_test(px, py).expect("hit");
        assert_eq!(h.pos.ord, 0);
        assert!(h.inside);
        assert!(h.link.is_none());
        // 링크 글자 위
        let (_, ty) = v.text_point(0, 6).unwrap();
        let (lx, _) = {
            let Item::Text { x, .. } = &v.layout.items[0] else {
                panic!()
            };
            (*x, 0.0)
        };
        // 6 번째 글자(링크 안)의 x 는 DirectWrite 가 알려 준다
        let px_link = {
            let Item::Text { layout, .. } = &v.layout.items[0] else {
                panic!()
            };
            let (mut hx, mut hy) = (0f32, 0f32);
            let mut m = DWRITE_HIT_TEST_METRICS::default();
            unsafe {
                layout
                    .HitTestTextPosition(6, false, &mut hx, &mut hy, &mut m)
                    .unwrap();
            }
            (lx + v.col_x + hx + 3.0) * s
        };
        let h2 = v.hit_test(px_link, (ty - v.scroll) * s).expect("link hit");
        assert_eq!(h2.link.as_deref(), Some("https://a.example"));
        // 글 밖(문서 맨 아래 빈 곳)은 가장 가까운 글자로 끌려온다
        let far = v.hit_test(400.0, 590.0).expect("nearest");
        assert!(!far.inside || far.pos.ord <= 1);
    }

    #[test]
    fn relayout_keeps_the_block_being_read() {
        let src: String = (0..60)
            .map(|i| format!("문단 {i}: 한국어 문장이 길게 이어지는 글입니다. 창을 좁히면 줄이 늘어서 같은 위치의 글이 달라집니다. 읽던 곳에 머물러야 합니다.\n\n"))
            .collect();
        let Some(mut v) = view(&src) else { return };
        let at = v.layout.block_tops[30] + 10.0;
        v.scroll = at;
        v.scroll_target = at;
        v.cw = 520; // 좁힌다 — 줄이 늘고 문서가 길어진다
        let before_height = v.layout.height;
        v.relayout();
        v.ensure_all();
        assert!(v.layout.height > before_height);
        let idx = v.layout.block_tops.partition_point(|t| *t <= v.scroll) - 1;
        assert_eq!(idx, 30, "읽던 블록");
        assert!((v.scroll - v.layout.block_tops[30] - 10.0).abs() < 0.5);
    }

    #[test]
    fn selection_survives_a_relayout() {
        let Some(mut v) = view("첫 문단 글입니다\n\n둘째 문단\n") else {
            return;
        };
        v.sel = Some(Selection {
            anchor: Pos { ord: 0, off: 0 },
            focus: Pos { ord: 1, off: 2 },
        });
        let before = v.selected_text();
        v.cw = 500;
        v.relayout();
        v.ensure_all();
        assert_eq!(v.selected_text(), before);
        let _: Option<&Layout> = None;
        let _ = lay;
    }
}
