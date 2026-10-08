//! 렌더러(src/desktop/tauri-bridge.ts) → Rust 명령.
//!
//! ★ 렌더러는 마크다운(= 어디서 왔는지 모르는 입력)을 그리는 곳이다. 여기 내민 명령이 렌더러가 부를 수 있는 전부다.
//!   '임의 경로를 읽어 달라' 같은 명령을 더하지 마라.
//! ★ 대화상자가 뜰 수 있는 일은 전부 spawn_blocking 으로 돌린다. 명령을 처리하는 스레드에서 대화상자를 기다리면
//!   창이 멈춘다.

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::app::{
    open_dialog, open_external, open_file, save_document, save_settings, shared, theme_of,
    update_title,
};
use crate::links::resolve_doc_link;
use crate::menu;

#[derive(Serialize)]
pub struct Done {
    pub ok: bool,
}

/// 확대 단계를 한 칸 옮기고 모든 창에 적용한다.
pub fn step_zoom(app: &AppHandle, dir: i32) {
    let zoom = {
        let sh = shared(app);
        let mut s = sh.settings.lock().unwrap();
        s.step_zoom(dir);
        s.zoom
    };
    save_settings(app);
    for w in app.webview_windows().values() {
        let _ = w.set_zoom(zoom);
    }
    crate::native::each(app, |h| h.post(crate::preview::Cmd::Zoom(zoom as f32)));
}

/// 테마를 바꾸고 저장하고 모든 창에 알린다.
pub fn apply_theme(app: &AppHandle, theme: &str) {
    if !matches!(theme, "system" | "light" | "dark") {
        return;
    }
    shared(app).settings.lock().unwrap().theme = theme.to_string();
    save_settings(app);
    for w in app.webview_windows().values() {
        let _ = w.set_theme(theme_of(theme));
    }
    #[cfg(windows)]
    {
        let dark = match theme {
            "dark" => true,
            "light" => false,
            _ => crate::preview::window_system_dark(),
        };
        crate::native::each(app, |h| h.post(crate::preview::Cmd::Theme(dark)));
    }
    menu::broadcast_settings(app);
    menu::refresh(app);
}

#[tauri::command]
pub fn ready(app: AppHandle, window: WebviewWindow) {
    crate::app::on_ready(&app, window.label());
}

/// 렌더러가 첫 블록을 화면에 그렸다 — 네이티브 미리보기를 걷고 이 창을 보인다.
#[tauri::command]
pub fn painted(app: AppHandle, window: WebviewWindow) -> f64 {
    crate::trace::mark(&format!("painted {}", window.label()));
    crate::app::painted(&app, window.label())
}

/// 렌더러가 문서를 받았다 — 숨겨 두었다가 다시 쓴 창이 살아 있다는 표시(app::watch_reuse).
#[tauri::command]
pub fn received(app: AppHandle, window: WebviewWindow) {
    if let Some(d) = shared(&app).docs.lock().unwrap().get_mut(window.label()) {
        d.received = true;
    }
}

/// 렌더러가 미리보기의 읽는 자리로 가 있다 — 이제 넘긴다.
#[tauri::command]
pub fn swap(app: AppHandle, window: WebviewWindow) {
    crate::app::finish_swap(&app, window.label());
}

#[tauri::command]
pub fn open_link(app: AppHandle, window: WebviewWindow, href: String) {
    let label = window.label().to_string();
    let dir = shared(&app).docs.lock().unwrap().get(&label).and_then(|d| {
        d.path
            .as_ref()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
    });
    // ★ 네트워크 경로(//host · \\host)가 되는 링크는 여기서 걸러진다 — 열기만 해도 SMB 인증이 나간다(links.rs).
    let Some(path) = dir.and_then(|d| resolve_doc_link(&d, &href)) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        open_file(&app, Some(&label), &path, false, false);
    });
}

#[tauri::command]
pub fn zoom(app: AppHandle, dir: i32) {
    step_zoom(&app, dir.signum());
}

#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) {
    apply_theme(&app, &theme);
}

/// 메인이 맡은 동작. 이름은 화이트리스트로만 받는다.
#[tauri::command]
pub fn run(app: AppHandle, window: WebviewWindow, name: String) {
    let label = window.label().to_string();
    match name.as_str() {
        "open" => {
            tauri::async_runtime::spawn_blocking(move || open_dialog(&app, Some(&label)));
        }
        "close" => {
            let _ = window.close();
        }
        "quit" => crate::app::quit_all(&app),
        "fullscreen" => {
            let on = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!on);
        }
        _ => {}
    }
}

#[tauri::command]
pub fn set_dirty(app: AppHandle, window: WebviewWindow, dirty: bool) {
    let label = window.label().to_string();
    if let Some(d) = shared(&app).docs.lock().unwrap().get_mut(&label) {
        d.dirty = dirty;
    }
    update_title(&app, &label);
}

#[tauri::command]
pub async fn save(app: AppHandle, window: WebviewWindow, content: String) -> Done {
    let label = window.label().to_string();
    let ok = tauri::async_runtime::spawn_blocking(move || save_document(&app, &label, &content))
        .await
        .unwrap_or(false);
    Done { ok }
}

/// 'pdf': 저장 대화상자(문서 이름 · 문서 폴더로 채워 열린다)로 내보낸다.
/// 'preview' 는 렌더러가 window.print() 로 직접 한다(WebView2 의 미리보기 창).
#[tauri::command]
pub async fn print(app: AppHandle, window: WebviewWindow, mode: String) -> Done {
    if mode != "pdf" {
        let _ = window.eval("window.print()");
        return Done { ok: true };
    }
    let label = window.label().to_string();
    let ok = tauri::async_runtime::spawn_blocking(move || export_pdf(&app, &window, &label))
        .await
        .unwrap_or(false);
    Done { ok }
}

fn export_pdf(app: &AppHandle, window: &WebviewWindow, label: &str) -> bool {
    let sh = shared(app);
    let doc_path = sh
        .docs
        .lock()
        .unwrap()
        .get(label)
        .and_then(|d| d.path.clone());
    let Some(doc_path) = doc_path else {
        return false;
    };

    let bytes = match crate::webview::print_to_pdf(window) {
        Ok(b) => b,
        Err(e) => {
            crate::app::error_box(app, e);
            return false;
        }
    };
    // 개발 빌드 전용: 대화상자 없이 이 경로에 쓴다(자동 시험용). 배포 빌드에는 들어가지 않는다.
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("MARKLET_TEST_PDF") {
        return std::fs::write(p, bytes).is_ok();
    }
    let stem = doc_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut dlg = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(format!("{stem}.pdf"))
        .set_parent(window);
    if let Some(dir) = doc_path.parent() {
        dlg = dlg.set_directory(dir);
    }
    let Some(target) = dlg.blocking_save_file() else {
        return false;
    };
    let Ok(path) = target.into_path() else {
        return false;
    };
    if let Err(e) = std::fs::write(&path, bytes) {
        crate::app::error_box(app, format!("{}\n\n{e}", path.display()));
        return false;
    }
    true
}

#[tauri::command]
pub fn open_external_url(url: String) {
    open_external(&url);
}

/// Alt: 메뉴 막대를 보이거나 숨긴다.
#[tauri::command]
pub fn toggle_menu(window: WebviewWindow) {
    if window.is_menu_visible().unwrap_or(false) {
        let _ = window.hide_menu();
    } else {
        let _ = window.show_menu();
    }
}
