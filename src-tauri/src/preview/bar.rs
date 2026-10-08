//! 메뉴 막대(Alt) — 네이티브 뷰어 창의 Win32 메뉴. 웹 창의 메뉴(src-tauri/src/menu.rs)와 같은 항목 · 같은 글이다.
//!
//! 사진 뷰어처럼 평소에는 숨겨져 있고 Alt 를 누르면 나온다. 항목은 이름(`open` · `theme:dark` · `recent:2` …)으로 앱에 알린다 —
//! 창이 직접 하는 것(찾기 · 목차 · 원문 보기 · 전체 화면 · 닫기 · 확대)은 창이, 나머지는 앱(`menu::run_action`)이 한다.

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::strings::Strings;

/// 메뉴가 그릴 때 알아야 하는 현재 상태
pub struct MenuState {
    /// system | light | dark
    pub theme: String,
    pub remote_images: bool,
    pub native_view: bool,
    pub keep_warm: bool,
    pub autostart: bool,
    /// 최근 문서의 파일 이름들
    pub recent: Vec<String>,
}

const BASE: u32 = 3000;

pub struct Bar {
    pub hmenu: HMENU,
    /// 항목 id → 이름
    names: Vec<(u32, String)>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn label(text: &str, key: &str) -> String {
    if key.is_empty() {
        text.to_string()
    } else {
        format!("{text}\t{key}")
    }
}

impl Bar {
    pub fn build(tr: &Strings, st: &MenuState) -> Option<Bar> {
        unsafe {
            let mut bar = Bar {
                hmenu: CreateMenu().ok()?,
                names: Vec::new(),
            };
            let file = CreatePopupMenu().ok()?;
            bar.item(file, "open", &label(tr.open, "Ctrl+O"));
            let recent = CreatePopupMenu().ok()?;
            if st.recent.is_empty() {
                let w = wide(tr.no_recent);
                let _ = AppendMenuW(recent, MF_STRING | MF_GRAYED, 0, PCWSTR(w.as_ptr()));
            } else {
                for (i, name) in st.recent.iter().enumerate() {
                    bar.item(recent, &format!("recent:{i}"), name);
                }
                let _ = AppendMenuW(recent, MF_SEPARATOR, 0, PCWSTR::null());
                bar.item(recent, "clear_recent", tr.clear_recent);
            }
            let w = wide(tr.recent);
            let _ = AppendMenuW(
                file,
                MF_STRING | MF_POPUP,
                recent.0 as usize,
                PCWSTR(w.as_ptr()),
            );
            sep(file);
            bar.item(file, "reveal", tr.reveal);
            bar.item(file, "copy_path", tr.copy_path);
            sep(file);
            bar.item(file, "print", &label(tr.print, "Ctrl+P"));
            bar.item(file, "pdf", &label(tr.export_pdf, "Ctrl+Shift+P"));
            bar.item(file, "close", &label(tr.close, "Ctrl+W"));
            bar.item(file, "quit", &label(tr.quit, "Ctrl+Q"));
            bar.popup(file, tr.file);

            let view = CreatePopupMenu().ok()?;
            bar.item(view, "edit", &label(tr.edit, "Ctrl+E"));
            sep(view);
            bar.item(view, "toc", &label(tr.toc, "Ctrl+T"));
            bar.item(view, "find", &label(tr.find, "Ctrl+F"));
            bar.item(view, "source", &label(tr.source, "Ctrl+U"));
            sep(view);
            bar.item(view, "zoom_in", &label(tr.zoom_in, "Ctrl++"));
            bar.item(view, "zoom_out", &label(tr.zoom_out, "Ctrl+-"));
            bar.item(view, "zoom_reset", &label(tr.zoom_reset, "Ctrl+0"));
            sep(view);
            let theme = CreatePopupMenu().ok()?;
            bar.item(theme, "theme:system", tr.theme_system);
            bar.item(theme, "theme:light", tr.theme_light);
            bar.item(theme, "theme:dark", tr.theme_dark);
            let w = wide(tr.theme);
            let _ = AppendMenuW(
                view,
                MF_STRING | MF_POPUP,
                theme.0 as usize,
                PCWSTR(w.as_ptr()),
            );
            bar.item(view, "remote", tr.remote);
            bar.item(view, "native_view", tr.native_view);
            bar.item(view, "keep_warm", tr.keep_warm);
            bar.item(view, "autostart", tr.autostart);
            sep(view);
            bar.item(view, "fullscreen", &label(tr.fullscreen, "F11"));
            bar.popup(view, tr.view);

            let help = CreatePopupMenu().ok()?;
            bar.item(help, "set_default", tr.set_default);
            bar.item(help, "licenses", tr.licenses);
            bar.item(help, "about", tr.about);
            bar.popup(help, tr.help);

            bar.update(st);
            Some(bar)
        }
    }

    unsafe fn item(&mut self, menu: HMENU, name: &str, text: &str) {
        let id = BASE + self.names.len() as u32;
        self.names.push((id, name.to_string()));
        let w = wide(text);
        let _ = AppendMenuW(menu, MF_STRING, id as usize, PCWSTR(w.as_ptr()));
    }

    unsafe fn popup(&mut self, sub: HMENU, text: &str) {
        let w = wide(text);
        let _ = AppendMenuW(
            self.hmenu,
            MF_STRING | MF_POPUP,
            sub.0 as usize,
            PCWSTR(w.as_ptr()),
        );
    }

    fn id_of(&self, name: &str) -> Option<u32> {
        self.names.iter().find(|(_, n)| n == name).map(|(i, _)| *i)
    }

    /// 항목의 이름(앱에 알릴 것). 메뉴가 아닌 id 면 None.
    pub fn name_of(&self, id: u32) -> Option<&str> {
        self.names
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, n)| n.as_str())
    }

    /// 체크 · 라디오 표시를 현재 상태로 맞춘다(메뉴가 열릴 때마다 부른다)
    pub fn update(&self, st: &MenuState) {
        unsafe {
            let check = |name: &str, on: bool| {
                if let Some(id) = self.id_of(name) {
                    let _ = CheckMenuItem(
                        self.hmenu,
                        id,
                        (MF_BYCOMMAND | if on { MF_CHECKED } else { MF_UNCHECKED }).0,
                    );
                }
            };
            check("remote", st.remote_images);
            check("native_view", st.native_view);
            check("keep_warm", st.keep_warm);
            check("autostart", st.autostart);
            let ids: Vec<u32> = ["theme:system", "theme:light", "theme:dark"]
                .iter()
                .filter_map(|n| self.id_of(n))
                .collect();
            if let (Some(first), Some(last)) = (ids.first(), ids.last()) {
                let cur = format!("theme:{}", st.theme);
                if let Some(c) = self.id_of(&cur) {
                    let _ = CheckMenuRadioItem(self.hmenu, *first, *last, c, MF_BYCOMMAND.0);
                }
            }
        }
    }

    pub fn destroy(self) {
        unsafe {
            let _ = DestroyMenu(self.hmenu);
        }
    }
}

fn sep(menu: HMENU) {
    unsafe {
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    }
}
