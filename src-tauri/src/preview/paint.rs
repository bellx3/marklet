//! 그리기 — 문서 · 고른 글 · 찾은 글 · 그림 · 목차 도크 · 찾기 막대 · 스크롤바. Direct2D.
//!
//! 그리는 것은 전부 CSS px 로 적는다. 렌더 타깃의 DPI(= 화면 배율 × 확대)가 물리 px 로 바꿔 준다.

use std::sync::Arc;

use windows::core::Interface;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows_numerics::{Matrix3x2, Vector2};

use super::layout::{palette, Col, Item};
use super::view::*;

fn rect(l: f32, t: f32, r: f32, b: f32) -> D2D_RECT_F {
    D2D_RECT_F {
        left: l,
        top: t,
        right: r,
        bottom: b,
    }
}

/// 글 범위 [start, start+len) 가 차지하는 상자들(글 상자 안 좌표). 줄이 나뉘면 여럿이다.
fn range_rects(layout: &IDWriteTextLayout, start: u32, len: u32) -> Vec<DWRITE_HIT_TEST_METRICS> {
    unsafe {
        let mut count = 0u32;
        let _ = layout.HitTestTextRange(start, len, 0.0, 0.0, None, &mut count);
        if count == 0 {
            return Vec::new();
        }
        let mut ms = vec![DWRITE_HIT_TEST_METRICS::default(); count as usize];
        let _ = layout.HitTestTextRange(start, len, 0.0, 0.0, Some(&mut ms), &mut count);
        ms.truncate(count as usize);
        ms
    }
}

/// 찾기 막대의 자리(CSS px, 클라이언트 위쪽 기준)
#[derive(Clone, Copy, Debug)]
pub struct FindGeo {
    pub bar: [f32; 4],
    pub pill: [f32; 4],
    pub counter: [f32; 4],
    pub prev: [f32; 4],
    pub next: [f32; 4],
    pub close: [f32; 4],
}

/// 막대 높이: 위 여백 8 + 입력칸 48 + 아래 여백 8 + 테두리 1
pub const FIND_H: f32 = 65.0;

impl View {
    pub fn pal(&self, c: Col) -> D2D1_COLOR_F {
        let p = palette(self.dark)[c as usize];
        D2D1_COLOR_F {
            r: p[0],
            g: p[1],
            b: p[2],
            a: p[3],
        }
    }

    fn brush(&self, c: Col) -> ID2D1Brush {
        self.brushes.b[c as usize].cast().expect("brush")
    }

    // ── 화면 장치의 자리 ───────────────────────────────────────────────────────

    pub fn find_geo(&self) -> FindGeo {
        let dock = if self.dock_open { DOCK_W } else { 0.0 };
        let avail = self.view_w() - SCROLLBAR - dock;
        let bar_w = avail.min(MD_MEASURE);
        let bx = dock + (avail - bar_w) / 2.0;
        let (btn, gap) = (48.0, 4.0);
        let close = [bx + bar_w - 8.0 - btn, 8.0, bx + bar_w - 8.0, 8.0 + btn];
        let next = [close[0] - gap - btn, 8.0, close[0] - gap, 8.0 + btn];
        let prev = [next[0] - gap - btn, 8.0, next[0] - gap, 8.0 + btn];
        let counter = [prev[0] - gap - 56.0, 8.0, prev[0] - gap, 8.0 + btn];
        let pill = [bx + 8.0, 8.0, counter[0] - gap, 8.0 + btn];
        FindGeo {
            bar: [bx, 0.0, bx + bar_w, FIND_H],
            pill,
            counter,
            prev,
            next,
            close,
        }
    }

    /// 떠오르는 컨트롤 막대(CSS px, 클라이언트 위쪽 기준)와 단추 다섯 개의 자리. 오른쪽 위에 놓인다(스크롤바 안쪽).
    pub fn ctl_rects(&self) -> ([f32; 4], [[f32; 4]; 5]) {
        let w = 5.0 * 34.0 + 4.0 * 2.0 + 6.0;
        let right = self.view_w() - 24.0;
        let (x0, y0) = (right - w, 14.0);
        let bar = [x0, y0, right, y0 + 40.0];
        let mut b = [[0.0; 4]; 5];
        for (i, r) in b.iter_mut().enumerate() {
            let x = x0 + 3.0 + i as f32 * 36.0;
            *r = [x, y0 + 3.0, x + 34.0, y0 + 37.0];
        }
        (bar, b)
    }

    /// (이름, 단축키, 아이콘 글리프) — 툴팁과 아이콘이 쓴다
    pub fn ctl_info(&self, i: usize) -> (&'static str, &'static str, char) {
        let ko = self.ctx.korean;
        match i {
            0 => (if ko { "편집" } else { "Edit" }, "Ctrl+E", '\u{E70F}'),
            1 => (if ko { "목차" } else { "Outline" }, "Ctrl+T", '\u{E8FD}'),
            2 => (if ko { "찾기" } else { "Find" }, "Ctrl+F", '\u{E721}'),
            3 => (if ko { "테마" } else { "Theme" }, "", '\u{E708}'),
            _ => (if ko { "더 보기" } else { "More" }, "", '\u{E712}'),
        }
    }

    /// 도크 닫기 단추(34×34)의 자리
    pub fn dock_close_rect(&self) -> [f32; 4] {
        let (cx, cy) = (DOCK_W - 10.0 - 17.0, 14.0 + 17.0);
        [cx - 17.0, cy - 17.0, cx + 17.0, cy + 17.0]
    }

    /// 스크롤바의 손잡이(CSS px, 클라이언트 기준). 문서가 한 화면이면 None.
    pub fn thumb_rect(&self) -> Option<[f32; 4]> {
        let view = self.view_h();
        let total = self.layout.height;
        if total <= view + 1.0 {
            return None;
        }
        let vw = self.view_w();
        let thumb_h = (view * view / total).max(32.0);
        let y = self.scroll / (total - view) * (view - thumb_h);
        Some([vw - 8.0, y + 2.0, vw - 2.0, y + thumb_h - 2.0])
    }

    fn in_rect(r: &[f32; 4], x: f32, y: f32) -> bool {
        x >= r[0] && x < r[2] && y >= r[1] && y < r[3]
    }

    /// 클라이언트 물리 px 의 한 점이 화면 장치 위인가. 위에서부터(막대 → 도크 → 스크롤바) 본다.
    pub fn ui_hit(&self, px: f32, py: f32) -> Option<Ui> {
        let s = self.scale();
        let (x, y) = (px / s, py / s);
        if self.ctl_shown && !self.find_open {
            let (bar, btns) = self.ctl_rects();
            for (i, r) in btns.iter().enumerate() {
                if Self::in_rect(r, x, y) {
                    return Some(Ui::Ctl(i as u8));
                }
            }
            if Self::in_rect(&bar, x, y) {
                return Some(Ui::CtlBar);
            }
        }
        if self.find_open {
            let g = self.find_geo();
            if Self::in_rect(&g.close, x, y) {
                return Some(Ui::FindClose);
            }
            if Self::in_rect(&g.next, x, y) {
                return Some(Ui::FindNext);
            }
            if Self::in_rect(&g.prev, x, y) {
                return Some(Ui::FindPrev);
            }
            if Self::in_rect(&g.pill, x, y) {
                return Some(Ui::FindInput);
            }
            if Self::in_rect(&g.bar, x, y) {
                return Some(Ui::FindBar);
            }
        }
        if self.dock_open && x < DOCK_W {
            if Self::in_rect(&self.dock_close_rect(), x, y) {
                return Some(Ui::DockClose);
            }
            if y >= DOCK_HEAD_H {
                if let Some(i) = self.dock_item_at(y) {
                    return Some(Ui::DockItem(i));
                }
            }
            return Some(Ui::DockArea);
        }
        let vw = self.view_w();
        if x >= vw - SCROLLBAR {
            if let Some(t) = self.thumb_rect() {
                if y >= t[1] - 2.0 && y < t[3] + 2.0 {
                    return Some(Ui::Thumb);
                }
            }
            if self.layout.height > self.view_h() + 1.0 {
                return Some(Ui::Track);
            }
        }
        None
    }

    // ── 그리기 ─────────────────────────────────────────────────────────────

    pub fn paint(&mut self, rt: &ID2D1RenderTarget) {
        unsafe {
            let s = self.scale();
            rt.SetDpi(96.0 * s, 96.0 * s);
            rt.BeginDraw();
            rt.Clear(Some(&self.pal(Col::Bg)));
            self.paint_doc(rt);
            if self.dock_open {
                self.paint_dock(rt);
            }
            if self.find_open {
                self.paint_find_bar(rt);
            } else if self.ctl_shown {
                self.paint_controls(rt);
            }
            self.paint_scrollbar(rt);
            // 메뉴는 모든 것 위에
            if self.popup.is_some() {
                self.paint_popup(rt);
            }
            let _ = rt.EndDraw(None, None);
        }
    }

    unsafe fn paint_doc(&mut self, rt: &ID2D1RenderTarget) {
        let top = self.scroll;
        let bottom = self.scroll + self.view_h();
        let (ox, oy) = (self.col_x, -self.scroll);
        let fg: ID2D1Brush = self.brush(Col::Fg);
        let sel = self.sel.filter(|s| !s.is_empty()).map(|s| s.ordered());
        let cur = self.find.current;
        let mut wanted: Vec<Arc<std::path::PathBuf>> = Vec::new();

        for it in &self.layout.items {
            match it {
                Item::Text {
                    layout,
                    x,
                    y,
                    h,
                    clip,
                    meta,
                } => {
                    if *y + *h < top - 20.0 || *y > bottom + 20.0 {
                        continue;
                    }
                    let hscroll = match (clip, meta) {
                        (Some(_), Some(m)) => m.hscroll.get(),
                        _ => 0.0,
                    };
                    if let Some(c) = clip {
                        rt.PushAxisAlignedClip(
                            &rect(c[0] + ox, c[1] + oy, c[2] + ox, c[3] + oy),
                            D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                        );
                    }
                    let (tx, ty) = (*x + ox - hscroll, *y + oy);
                    if let Some(m) = meta {
                        // 찾은 글
                        for fm in self.find.in_text(m.ord) {
                            let is_cur = cur.map(|i| self.find.matches[i] == *fm).unwrap_or(false);
                            for r in range_rects(layout, fm.start, fm.end - fm.start) {
                                let rc = rect(
                                    tx + r.left - 1.0,
                                    ty + r.top,
                                    tx + r.left + r.width + 1.0,
                                    ty + r.top + r.height,
                                );
                                let rr = D2D1_ROUNDED_RECT {
                                    rect: rc,
                                    radiusX: 2.0,
                                    radiusY: 2.0,
                                };
                                rt.FillRoundedRectangle(
                                    &rr,
                                    &self.brushes.b
                                        [if is_cur { Col::HitCur } else { Col::Hit } as usize],
                                );
                                if is_cur {
                                    rt.DrawRoundedRectangle(
                                        &rr,
                                        &self.brushes.b[Col::HitOutline as usize],
                                        2.0,
                                        None,
                                    );
                                }
                            }
                        }
                        // 고른 글
                        if let Some((a, b)) = sel {
                            if m.ord >= a.ord && m.ord <= b.ord {
                                let s0 = if m.ord == a.ord { a.off } else { 0 };
                                let e0 = if m.ord == b.ord {
                                    b.off.min(m.text.len() as u32)
                                } else {
                                    m.text.len() as u32
                                };
                                if e0 > s0 {
                                    for r in range_rects(layout, s0, e0 - s0) {
                                        rt.FillRectangle(
                                            &rect(
                                                tx + r.left,
                                                ty + r.top,
                                                tx + r.left + r.width,
                                                ty + r.top + r.height,
                                            ),
                                            &self.brushes.b[Col::Sel as usize],
                                        );
                                    }
                                }
                            }
                        }
                    }
                    rt.DrawTextLayout(
                        Vector2 { X: tx, Y: ty },
                        layout,
                        &fg,
                        D2D1_DRAW_TEXT_OPTIONS_NONE,
                    );
                    if clip.is_some() {
                        rt.PopAxisAlignedClip();
                        self.paint_code_scrollbar(rt, it, ox, oy);
                    }
                }
                Item::Fill { r, col, radius } => {
                    if r[3] < top - 20.0 || r[1] > bottom + 20.0 {
                        continue;
                    }
                    let rc = rect(r[0] + ox, r[1] + oy, r[2] + ox, r[3] + oy);
                    let b = &self.brushes.b[*col as usize];
                    if *radius > 0.0 {
                        rt.FillRoundedRectangle(
                            &D2D1_ROUNDED_RECT {
                                rect: rc,
                                radiusX: *radius,
                                radiusY: *radius,
                            },
                            b,
                        );
                    } else {
                        rt.FillRectangle(&rc, b);
                    }
                }
                Item::Stroke {
                    r,
                    col,
                    width,
                    radius,
                } => {
                    if r[3] < top - 20.0 || r[1] > bottom + 20.0 {
                        continue;
                    }
                    let half = width / 2.0;
                    let rc = rect(
                        r[0] + ox + half,
                        r[1] + oy + half,
                        r[2] + ox - half,
                        r[3] + oy - half,
                    );
                    rt.DrawRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect: rc,
                            radiusX: *radius,
                            radiusY: *radius,
                        },
                        &self.brushes.b[*col as usize],
                        *width,
                        None,
                    );
                }
                Item::Line {
                    x1,
                    y1,
                    x2,
                    y2,
                    col,
                    width,
                } => {
                    if y1.max(*y2) < top - 20.0 || y1.min(*y2) > bottom + 20.0 {
                        continue;
                    }
                    rt.DrawLine(
                        Vector2 {
                            X: *x1 + ox,
                            Y: *y1 + oy,
                        },
                        Vector2 {
                            X: *x2 + ox,
                            Y: *y2 + oy,
                        },
                        &self.brushes.b[*col as usize],
                        *width,
                        None,
                    );
                }
                Item::Check {
                    x,
                    y,
                    size,
                    checked,
                } => {
                    if *y + *size < top - 20.0 || *y > bottom + 20.0 {
                        continue;
                    }
                    let rc = rect(*x + ox, *y + oy, *x + ox + *size, *y + oy + *size);
                    let rr = D2D1_ROUNDED_RECT {
                        rect: rc,
                        radiusX: 3.0,
                        radiusY: 3.0,
                    };
                    if *checked {
                        rt.FillRoundedRectangle(&rr, &self.brushes.b[Col::Link as usize]);
                        let bg = &self.brushes.b[Col::Bg as usize];
                        let (cx, cy) = (*x + ox, *y + oy);
                        let p = |fx: f32, fy: f32| Vector2 {
                            X: cx + fx * *size,
                            Y: cy + fy * *size,
                        };
                        rt.DrawLine(p(0.25, 0.52), p(0.43, 0.70), bg, 1.8, None);
                        rt.DrawLine(p(0.43, 0.70), p(0.76, 0.32), bg, 1.8, None);
                    } else {
                        rt.DrawRoundedRectangle(
                            &rr,
                            &self.brushes.b[Col::QuoteBar as usize],
                            1.5,
                            None,
                        );
                    }
                }
                Item::Image(im) => {
                    if im.y + im.h < top - 20.0 || im.y > bottom + 20.0 {
                        continue;
                    }
                    let dest = rect(im.x + ox, im.y + oy, im.x + ox + im.w, im.y + oy + im.h);
                    let ready = match self.images.get(&*im.path) {
                        Some(ImgSlot::Ready(bmp)) => Some(bmp),
                        Some(_) => None,
                        None => {
                            wanted.push(im.path.clone());
                            None
                        }
                    };
                    let rr = D2D1_ROUNDED_RECT {
                        rect: dest,
                        radiusX: 6.0,
                        radiusY: 6.0,
                    };
                    match ready {
                        Some(bmp) => {
                            // 둥근 모서리(6px)로 자른다: 그림을 붓으로 삼아 둥근 사각형을 칠한다
                            let size = bmp.GetSize();
                            if let Ok(brush) = rt.CreateBitmapBrush(bmp, None, None) {
                                brush.SetTransform(&Matrix3x2 {
                                    M11: im.w / size.width.max(1.0),
                                    M12: 0.0,
                                    M21: 0.0,
                                    M22: im.h / size.height.max(1.0),
                                    M31: dest.left,
                                    M32: dest.top,
                                });
                                rt.FillRoundedRectangle(&rr, &brush);
                            }
                        }
                        None => {
                            rt.FillRoundedRectangle(&rr, &self.brushes.b[Col::CodeBlock as usize]);
                        }
                    }
                }
            }
        }
        for p in wanted {
            if !self.images.contains_key(&*p) {
                self.images.insert((*p).clone(), ImgSlot::Loading);
                self.want_images.push(p);
            }
        }
    }

    /// 코드 상자 안쪽 아래의 가로 스크롤바(상자가 넘칠 때만)
    unsafe fn paint_code_scrollbar(&self, rt: &ID2D1RenderTarget, it: &Item, ox: f32, oy: f32) {
        let Item::Text {
            clip: Some(c),
            meta: Some(m),
            ..
        } = it
        else {
            return;
        };
        let visible = c[2] - c[0];
        let total = m.content_w;
        if total <= visible + 0.5 {
            return;
        }
        let track_w = visible;
        let thumb_w = (visible * visible / total).max(24.0).min(track_w);
        let max_scroll = total - visible;
        let x = c[0] + m.hscroll.get().clamp(0.0, max_scroll) / max_scroll * (track_w - thumb_w);
        let y = c[3] - 8.0;
        rt.FillRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: rect(x + ox, y + oy, x + thumb_w + ox, y + 5.0 + oy),
                radiusX: 2.5,
                radiusY: 2.5,
            },
            &self.brushes.b[Col::Thumb as usize],
        );
    }

    unsafe fn paint_scrollbar(&self, rt: &ID2D1RenderTarget) {
        let Some(t) = self.thumb_rect() else { return };
        rt.FillRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: rect(t[0], t[1], t[2], t[3]),
                radiusX: 3.0,
                radiusY: 3.0,
            },
            &self.brushes.b[if self.thumb_hot {
                Col::ThumbHover
            } else {
                Col::Thumb
            } as usize],
        );
    }

    /// 아이콘(선으로 그린 ✕ · ∧ · ∨). cx, cy 가 가운데, k 가 반 크기.
    unsafe fn icon(&self, rt: &ID2D1RenderTarget, kind: char, cx: f32, cy: f32, col: Col) {
        let b = &self.brushes.b[col as usize];
        let p = |x: f32, y: f32| Vector2 { X: x, Y: y };
        match kind {
            'x' => {
                rt.DrawLine(p(cx - 4.5, cy - 4.5), p(cx + 4.5, cy + 4.5), b, 1.6, None);
                rt.DrawLine(p(cx - 4.5, cy + 4.5), p(cx + 4.5, cy - 4.5), b, 1.6, None);
            }
            'u' => {
                rt.DrawLine(p(cx - 5.0, cy + 2.5), p(cx, cy - 2.5), b, 1.8, None);
                rt.DrawLine(p(cx, cy - 2.5), p(cx + 5.0, cy + 2.5), b, 1.8, None);
            }
            _ => {
                rt.DrawLine(p(cx - 5.0, cy - 2.5), p(cx, cy + 2.5), b, 1.8, None);
                rt.DrawLine(p(cx, cy + 2.5), p(cx + 5.0, cy - 2.5), b, 1.8, None);
            }
        }
    }

    unsafe fn paint_dock(&self, rt: &ID2D1RenderTarget) {
        let h = self.view_h();
        let hair = self.hair();
        rt.FillRectangle(
            &rect(0.0, 0.0, DOCK_W, h),
            &self.brushes.b[Col::Bg as usize],
        );
        rt.DrawLine(
            Vector2 {
                X: DOCK_W - hair / 2.0,
                Y: 0.0,
            },
            Vector2 {
                X: DOCK_W - hair / 2.0,
                Y: h,
            },
            &self.brushes.b[Col::Border as usize],
            hair,
            None,
        );
        // 머리: 제목 + 닫기
        let title = if self.ctx.korean { "목차" } else { "Outline" };
        if let Some(l) = self.gfx.ui_layout(title, 12.0, true, 200.0, 20.0) {
            rt.DrawTextLayout(
                Vector2 {
                    X: 18.0,
                    Y: 14.0 + 8.0,
                },
                &l,
                &self.brush(Col::Muted),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            );
        }
        let cr = self.dock_close_rect();
        if self.ui_hover == Some(Ui::DockClose) {
            rt.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: rect(cr[0], cr[1], cr[2], cr[3]),
                    radiusX: 17.0,
                    radiusY: 17.0,
                },
                &self.brushes.b[Col::CodeInline as usize],
            );
        }
        self.icon(
            rt,
            'x',
            (cr[0] + cr[2]) / 2.0,
            (cr[1] + cr[3]) / 2.0,
            Col::Fg,
        );

        // 목록
        rt.PushAxisAlignedClip(
            &rect(0.0, DOCK_HEAD_H, DOCK_W - hair, h),
            D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
        );
        let active = self.active_heading();
        let inner = DOCK_W - 16.0 - SCROLLBAR;
        for (i, it) in self.dock_items.iter().enumerate() {
            let y = DOCK_HEAD_H + it.top - self.dock_scroll;
            if y + it.h < DOCK_HEAD_H || y > h {
                continue;
            }
            let is_active = active == Some(it.heading);
            if is_active || self.dock_hover == Some(i) {
                rt.FillRoundedRectangle(
                    &D2D1_ROUNDED_RECT {
                        rect: rect(8.0, y, 8.0 + inner, y + it.h),
                        radiusX: 8.0,
                        radiusY: 8.0,
                    },
                    &self.brushes.b[Col::CodeInline as usize],
                );
            }
            let lv = match it.level {
                1 => 1.0,
                2 => 2.0,
                3 => 3.0,
                _ => 4.0,
            };
            let indent = 10.0 + (lv - 1.0) * 14.0;
            let col = if is_active {
                Col::Link
            } else if it.level <= 2 {
                Col::Fg
            } else {
                Col::Muted
            };
            rt.DrawTextLayout(
                Vector2 {
                    X: 8.0 + indent,
                    Y: y + 6.0,
                },
                &it.layout,
                &self.brush(col),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            );
        }
        rt.PopAxisAlignedClip();
        // 목록 스크롤바
        let list_h = self.dock_list_h();
        if self.dock_content_h > list_h + 1.0 {
            let thumb_h = (list_h * list_h / self.dock_content_h).max(24.0);
            let max = self.dock_content_h - list_h;
            let ty = DOCK_HEAD_H + self.dock_scroll / max * (list_h - thumb_h);
            rt.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: rect(DOCK_W - 8.0, ty + 2.0, DOCK_W - 3.0, ty + thumb_h - 2.0),
                    radiusX: 2.5,
                    radiusY: 2.5,
                },
                &self.brushes.b[Col::Thumb as usize],
            );
        }
    }

    /// 떠오르는 컨트롤: 알약 모양 막대에 단추 다섯 개. 마우스를 잠깐 올려 두면 툴팁(이름 + 단축키)이 뜬다.
    unsafe fn paint_controls(&self, rt: &ID2D1RenderTarget) {
        let (bar, btns) = self.ctl_rects();
        let hair = self.hair();
        let pill = D2D1_ROUNDED_RECT {
            rect: rect(bar[0], bar[1], bar[2], bar[3]),
            radiusX: 20.0,
            radiusY: 20.0,
        };
        rt.FillRoundedRectangle(&pill, &self.brushes.b[Col::Bg as usize]);
        let edge = D2D1_ROUNDED_RECT {
            rect: rect(
                bar[0] + hair / 2.0,
                bar[1] + hair / 2.0,
                bar[2] - hair / 2.0,
                bar[3] - hair / 2.0,
            ),
            radiusX: 20.0,
            radiusY: 20.0,
        };
        rt.DrawRoundedRectangle(&edge, &self.brushes.b[Col::Border as usize], hair, None);
        for (i, r) in btns.iter().enumerate() {
            let (cx, cy) = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
            let on = (i == 2 && self.find_open) || (i == 1 && self.dock_open);
            if on || self.ui_hover == Some(Ui::Ctl(i as u8)) {
                rt.FillRoundedRectangle(
                    &D2D1_ROUNDED_RECT {
                        rect: rect(r[0], r[1], r[2], r[3]),
                        radiusX: 17.0,
                        radiusY: 17.0,
                    },
                    &self.brushes.b[Col::CodeInline as usize],
                );
            }
            let (_, _, glyph) = self.ctl_info(i);
            if let Some(l) = self.gfx.icon_layout(glyph, 16.0) {
                let mut m = DWRITE_TEXT_METRICS::default();
                let _ = l.GetMetrics(&mut m);
                rt.DrawTextLayout(
                    Vector2 {
                        X: cx - m.width / 2.0,
                        Y: cy - m.height / 2.0,
                    },
                    &l,
                    &self.brush(Col::Fg),
                    D2D1_DRAW_TEXT_OPTIONS_NONE,
                );
            }
        }
        // 툴팁. 메뉴가 열려 있는 동안은 뜨지 않는다 — 메뉴가 같은 자리를 덮고, 가장자리로 삐져나온다.
        if self.popup.is_some() {
            return;
        }
        let (Some(Ui::Ctl(i)), Some(since)) = (self.ui_hover, self.ctl_hover_since) else {
            return;
        };
        if since.elapsed() < std::time::Duration::from_millis(350) {
            return;
        }
        let i = i as usize;
        let (label, key, _) = self.ctl_info(i);
        let Some(tl) = self.gfx.ui_layout(label, 12.5, false, 200.0, 20.0) else {
            return;
        };
        let kl = if key.is_empty() {
            None
        } else {
            self.gfx.ui_layout(key, 11.0, false, 200.0, 20.0)
        };
        let measure = |l: &IDWriteTextLayout| {
            let mut m = DWRITE_TEXT_METRICS::default();
            let _ = l.GetMetrics(&mut m);
            (m.width, m.height)
        };
        let (tw, th) = measure(&tl);
        let (kw, kh) = kl.as_ref().map(measure).unwrap_or((0.0, 0.0));
        let chip_w = if kl.is_some() { kw + 10.0 } else { 0.0 };
        let w = 10.0 + tw + if kl.is_some() { 8.0 + chip_w } else { 0.0 } + 10.0;
        let h = (th + 12.0).max(kh + 16.0);
        // 맨 오른쪽 단추는 화면 밖으로 나가지 않게 오른쪽 끝을 맞춘다
        let r = btns[i];
        let x = if i == 4 {
            r[2] - w
        } else {
            ((r[0] + r[2]) / 2.0 - w / 2.0).max(4.0)
        };
        let y = bar[3] + 10.0;
        rt.FillRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: rect(x, y, x + w, y + h),
                radiusX: 8.0,
                radiusY: 8.0,
            },
            &self.brushes.b[Col::Fg as usize],
        );
        rt.DrawTextLayout(
            Vector2 {
                X: x + 10.0,
                Y: y + (h - th) / 2.0,
            },
            &tl,
            &self.brush(Col::Bg),
            D2D1_DRAW_TEXT_OPTIONS_NONE,
        );
        if let Some(kl) = kl {
            let kx = x + 10.0 + tw + 8.0;
            rt.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: rect(
                        kx,
                        y + (h - kh - 4.0) / 2.0,
                        kx + chip_w,
                        y + (h + kh + 4.0) / 2.0,
                    ),
                    radiusX: 4.0,
                    radiusY: 4.0,
                },
                &self.brushes.b[Col::Muted as usize],
            );
            rt.DrawTextLayout(
                Vector2 {
                    X: kx + 5.0,
                    Y: y + (h - kh) / 2.0,
                },
                &kl,
                &self.brush(Col::Bg),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            );
        }
    }

    unsafe fn paint_find_bar(&self, rt: &ID2D1RenderTarget) {
        let g = self.find_geo();
        let hair = self.hair();
        // 막대 바탕(아래 문서가 비치지 않게) · 아래 테두리
        rt.FillRectangle(
            &rect(g.bar[0], 0.0, g.bar[2], FIND_H),
            &self.brushes.b[Col::Bg as usize],
        );
        rt.DrawLine(
            Vector2 {
                X: g.bar[0],
                Y: FIND_H - hair / 2.0,
            },
            Vector2 {
                X: g.bar[2],
                Y: FIND_H - hair / 2.0,
            },
            &self.brushes.b[Col::Border as usize],
            hair,
            None,
        );
        // 입력칸(알약). 글자는 창이 EDIT 컨트롤로 얹는다.
        let pill = D2D1_ROUNDED_RECT {
            rect: rect(g.pill[0], g.pill[1], g.pill[2], g.pill[3]),
            radiusX: 24.0,
            radiusY: 24.0,
        };
        rt.FillRoundedRectangle(&pill, &self.brushes.b[Col::CodeInline as usize]);
        let focus = D2D1_ROUNDED_RECT {
            rect: rect(
                g.pill[0] + 0.5,
                g.pill[1] + 0.5,
                g.pill[2] - 0.5,
                g.pill[3] - 0.5,
            ),
            radiusX: 24.0,
            radiusY: 24.0,
        };
        rt.DrawRoundedRectangle(&focus, &self.brushes.b[Col::Link as usize], 1.0, None);
        // 세는 칸
        if let Some(l) = self
            .gfx
            .ui_layout(&self.find.label(), 14.0, false, 56.0, 20.0)
        {
            let w = {
                let mut m = DWRITE_TEXT_METRICS::default();
                let _ = l.GetMetrics(&mut m);
                m.width
            };
            let cx = (g.counter[0] + g.counter[2]) / 2.0;
            rt.DrawTextLayout(
                Vector2 {
                    X: cx - w / 2.0,
                    Y: (g.counter[1] + g.counter[3]) / 2.0 - 8.5,
                },
                &l,
                &self.brush(Col::Muted),
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            );
        }
        // 단추
        let none = self.find.matches.is_empty();
        for (r, kind, ui) in [
            (g.prev, 'u', Ui::FindPrev),
            (g.next, 'd', Ui::FindNext),
            (g.close, 'x', Ui::FindClose),
        ] {
            let (cx, cy) = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
            let off = none && ui != Ui::FindClose;
            if self.ui_hover == Some(ui) && !off {
                rt.FillRoundedRectangle(
                    &D2D1_ROUNDED_RECT {
                        rect: rect(cx - 17.0, cy - 17.0, cx + 17.0, cy + 17.0),
                        radiusX: 17.0,
                        radiusY: 17.0,
                    },
                    &self.brushes.b[Col::CodeInline as usize],
                );
            }
            self.icon(rt, kind, cx, cy, if off { Col::QuoteBar } else { Col::Fg });
        }
    }

    /// 글 한 줄을 붓의 불투명도를 바꿔 그린다(흐린 항목 · 강조된 항목의 단축키). 그린 뒤 불투명도를 되돌린다.
    unsafe fn text_at(
        &self,
        rt: &ID2D1RenderTarget,
        l: &IDWriteTextLayout,
        x: f32,
        y: f32,
        col: Col,
        opacity: f32,
    ) {
        let br = self.brush(col);
        br.SetOpacity(opacity);
        rt.DrawTextLayout(Vector2 { X: x, Y: y }, l, &br, D2D1_DRAW_TEXT_OPTIONS_NONE);
        br.SetOpacity(1.0);
    }

    /// 우클릭 · 더 보기 메뉴. 웹 창의 `.mk-menu` 와 같은 모양이다: 둥근 상자 · 반전색 강조 · 오른쪽에 흐린 단축키 · 구분선 · 부드러운 그림자.
    /// (웹은 바탕이 92% 불투명 + 흐림이다. 여기는 불투명하게 칠한다 — 흐림 없이 비치면 아래 글이 지저분하게 보인다.)
    unsafe fn paint_popup(&self, rt: &ID2D1RenderTarget) {
        use super::menu::{Entry, ITEM_H, ITEM_RADIUS, RADIUS, SEP_H, SEP_INSET, SIDE};
        let Some(p) = &self.popup else { return };
        let hair = self.hair();
        let [l, t, r, b] = p.geo.rect;
        self.paint_shadow(rt, p.geo.rect);
        rt.FillRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: rect(l, t, r, b),
                radiusX: RADIUS,
                radiusY: RADIUS,
            },
            &self.brushes.b[Col::Bg as usize],
        );
        rt.DrawRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: rect(
                    l + hair / 2.0,
                    t + hair / 2.0,
                    r - hair / 2.0,
                    b - hair / 2.0,
                ),
                radiusX: RADIUS - hair / 2.0,
                radiusY: RADIUS - hair / 2.0,
            },
            &self.brushes.b[Col::Border as usize],
            hair,
            None,
        );
        for (i, e) in p.entries.iter().enumerate() {
            let row = p.geo.rows[i];
            match e {
                Entry::Sep => {
                    // 줄 높이(11)의 위에서 5 만큼 내려온 곳에 1px
                    let y = row[1] + (SEP_H - 1.0) / 2.0;
                    rt.FillRectangle(
                        &rect(row[0] + SEP_INSET, y, row[2] - SEP_INSET, y + hair),
                        &self.brushes.b[Col::Border as usize],
                    );
                }
                Entry::Item(it) => {
                    let hot = p.hot == Some(i) && it.enabled;
                    if hot {
                        rt.FillRoundedRectangle(
                            &D2D1_ROUNDED_RECT {
                                rect: rect(row[0], row[1], row[2], row[3]),
                                radiusX: ITEM_RADIUS,
                                radiusY: ITEM_RADIUS,
                            },
                            &self.brushes.b[Col::Accent as usize],
                        );
                    }
                    // 강조된 항목은 반전색(--accent-fg), 단축키는 그 위에서 70%. 흐린 항목은 통째로 38%.
                    let dim = if it.enabled { 1.0 } else { 0.38 };
                    let (fg, key_fg, key_op) = if hot {
                        (Col::AccentFg, Col::AccentFg, 0.7)
                    } else {
                        (Col::Fg, Col::Muted, 1.0)
                    };
                    if let Some(lay) = &p.labels[i] {
                        let lh = p.label_size[i].1;
                        self.text_at(
                            rt,
                            lay,
                            row[0] + SIDE,
                            row[1] + (ITEM_H - lh) / 2.0,
                            fg,
                            dim,
                        );
                    }
                    if let Some(lay) = &p.keys[i] {
                        let (kw, kh) = p.key_size[i];
                        self.text_at(
                            rt,
                            lay,
                            row[2] - SIDE - kw,
                            row[1] + (ITEM_H - kh) / 2.0,
                            key_fg,
                            key_op * dim,
                        );
                    }
                }
            }
        }
    }

    /// 상자 둘레의 그림자(`--shadow-2`: 0 8px 28px). 이 렌더 타깃에는 번짐 효과가 없어서 겹친 둥근 사각형으로 어림한다 —
    /// 바깥에서 안쪽으로 층을 쌓되 층마다 알파를 골라, 쌓인 농도가 가우스(σ = 번짐 / 2)의 꼬리를 따르게 한다.
    unsafe fn paint_shadow(&self, rt: &ID2D1RenderTarget, bx: [f32; 4]) {
        use super::menu::{phi, RADIUS, SHADOW_BLUR, SHADOW_DY};
        const STEPS: usize = 12;
        let sigma = SHADOW_BLUR / 2.0;
        // 붓 자체의 알파가 테마의 그림자 농도다(밝은 0.16 · 어두운 0.55). 층마다 불투명도로 줄여 쓴다.
        let base = self.pal(Col::Shadow).a;
        let brush = self.brush(Col::Shadow);
        let step = 4.0 * sigma / STEPS as f32;
        let mut acc = 0.0f32;
        for k in 0..STEPS {
            // 이 층이 상자 가장자리에서 벌어진 만큼(+ 가 바깥). 가장 바깥은 +2σ, 가장 안쪽은 -2σ 근처.
            let d = 2.0 * sigma - k as f32 * step;
            let target = base * (1.0 - phi((d - step / 2.0) / sigma));
            let a = ((target - acc) / (1.0 - acc)).clamp(0.0, 1.0);
            acc += a * (1.0 - acc);
            let rc = rect(
                bx[0] - d,
                bx[1] + SHADOW_DY - d,
                bx[2] + d,
                bx[3] + SHADOW_DY + d,
            );
            if a <= 0.0 || rc.right <= rc.left || rc.bottom <= rc.top {
                continue;
            }
            brush.SetOpacity(a / base);
            let rad = (RADIUS + d).max(0.0);
            rt.FillRoundedRectangle(
                &D2D1_ROUNDED_RECT {
                    rect: rc,
                    radiusX: rad,
                    radiusY: rad,
                },
                &brush,
            );
        }
        brush.SetOpacity(1.0);
    }

    /// 테마를 바꾼다: 붓의 색을 새 팔레트로 고친다(글에 걸린 붓도 같은 것이라 같이 바뀐다).
    pub fn set_dark(&mut self, dark: bool) {
        self.dark = dark;
        for (i, b) in self.brushes.b.iter().enumerate() {
            let c = palette(dark)[i];
            unsafe {
                b.SetColor(&D2D1_COLOR_F {
                    r: c[0],
                    g: c[1],
                    b: c[2],
                    a: c[3],
                });
            }
        }
    }
}
