//! 메뉴 막대(Alt).
//!
//! ★ 메뉴는 '꼭 필요한 것'만 둔다. 사진 뷰어처럼 화면에는 문서만 보이고, 메뉴는 Alt 를 누르면 나온다
//!   (창마다 숨겨 두었다가 렌더러가 Alt 를 알려 주면 보인다 — webview 쪽 tauri-bridge.ts).
//! ★ 단축키는 메뉴에 걸지 않는다. 글자(`Ctrl+O` …)만 적어 두고 실제 키 처리는 렌더러가 한다 —
//!   메뉴를 숨긴 창에서도 같은 키가 같게 동작해야 하고, 같은 키를 두 곳이 받으면 두 번 일어난다.
//! ★ 메뉴는 한 번만 만들고, 바뀌는 것(최근 문서 · 체크 · 활성)은 항목을 직접 고친다.
//!   메뉴를 통째로 다시 달면 숨겨 둔 창의 메뉴 막대가 다시 나타나 화면이 출렁인다.

use std::sync::{Arc, Mutex};

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::app::{
    focused_label, is_doc_path, open_dialog, open_file, save_settings, send_command, send_settings,
    shared, theme_of,
};

pub struct Handles<R: Runtime> {
    recent: Submenu<R>,
    save: MenuItem<R>,
    reveal: MenuItem<R>,
    copy_path: MenuItem<R>,
    print: MenuItem<R>,
    pdf: MenuItem<R>,
    edit: MenuItem<R>,
    toc: MenuItem<R>,
    find: MenuItem<R>,
    source: MenuItem<R>,
    theme: [CheckMenuItem<R>; 3],
    remote: CheckMenuItem<R>,
    keep_warm: CheckMenuItem<R>,
    autostart: CheckMenuItem<R>,
    native_view: CheckMenuItem<R>,
}

pub type SharedHandles = Arc<Mutex<Option<Handles<tauri::Wry>>>>;

fn item(app: &AppHandle, id: &str, text: &str, key: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    let label = if key.is_empty() {
        text.to_string()
    } else {
        format!("{text}\t{key}")
    };
    MenuItemBuilder::with_id(id, label).build(app)
}

/// 메뉴를 한 번 만들어 앱에 단다.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let tr = shared(app).tr;

    let open = item(app, "open", tr.open, "Ctrl+O")?;
    let recent = SubmenuBuilder::new(app, tr.recent).build()?;
    let save = item(app, "save", tr.save, "Ctrl+S")?;
    let reveal = item(app, "reveal", tr.reveal, "")?;
    let copy_path = item(app, "copy_path", tr.copy_path, "")?;
    let print = item(app, "print", tr.print, "Ctrl+P")?;
    let pdf = item(app, "pdf", tr.export_pdf, "Ctrl+Shift+P")?;
    let close = item(app, "close", tr.close, "Ctrl+W")?;
    let quit = item(app, "quit", tr.quit, "Ctrl+Q")?;
    let file = SubmenuBuilder::new(app, tr.file)
        .item(&open)
        .item(&recent)
        .item(&save)
        .separator()
        .item(&reveal)
        .item(&copy_path)
        .separator()
        .item(&print)
        .item(&pdf)
        .item(&close)
        .item(&quit)
        .build()?;

    let edit = item(app, "edit", tr.edit, "Ctrl+E")?;
    let toc = item(app, "toc", tr.toc, "Ctrl+T")?;
    let find = item(app, "find", tr.find, "Ctrl+F")?;
    let source = item(app, "source", tr.source, "Ctrl+U")?;
    let zoom_in = item(app, "zoom_in", tr.zoom_in, "Ctrl++")?;
    let zoom_out = item(app, "zoom_out", tr.zoom_out, "Ctrl+-")?;
    let zoom_reset = item(app, "zoom_reset", tr.zoom_reset, "Ctrl+0")?;
    let theme = [
        CheckMenuItemBuilder::with_id("theme:system", tr.theme_system).build(app)?,
        CheckMenuItemBuilder::with_id("theme:light", tr.theme_light).build(app)?,
        CheckMenuItemBuilder::with_id("theme:dark", tr.theme_dark).build(app)?,
    ];
    let theme_menu = SubmenuBuilder::new(app, tr.theme)
        .item(&theme[0])
        .item(&theme[1])
        .item(&theme[2])
        .build()?;
    let remote = CheckMenuItemBuilder::with_id("remote", tr.remote).build(app)?;
    let keep_warm = CheckMenuItemBuilder::with_id("keep_warm", tr.keep_warm).build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", tr.autostart).build(app)?;
    let native_view = CheckMenuItemBuilder::with_id("native_view", tr.native_view).build(app)?;
    let fullscreen = item(app, "fullscreen", tr.fullscreen, "F11")?;
    let view = SubmenuBuilder::new(app, tr.view)
        .item(&edit)
        .separator()
        .item(&toc)
        .item(&find)
        .item(&source)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&theme_menu)
        .item(&remote)
        .item(&native_view)
        .item(&keep_warm)
        .item(&autostart)
        .separator()
        .item(&fullscreen)
        .build()?;

    let set_default = item(app, "set_default", tr.set_default, "")?;
    let licenses = item(app, "licenses", tr.licenses, "")?;
    let about = item(app, "about", tr.about, "")?;
    let help = SubmenuBuilder::new(app, tr.help)
        .item(&set_default)
        .item(&licenses)
        .item(&about)
        .build()?;

    let menu: Menu<tauri::Wry> = MenuBuilder::new(app)
        .item(&file)
        .item(&view)
        .item(&help)
        .build()?;
    app.set_menu(menu)?;

    let handles: SharedHandles = app.state::<SharedHandles>().inner().clone();
    *handles.lock().unwrap() = Some(Handles {
        recent,
        save,
        reveal,
        copy_path,
        print,
        pdf,
        edit,
        toc,
        find,
        source,
        theme,
        remote,
        keep_warm,
        autostart,
        native_view,
    });
    refresh(app);
    Ok(())
}

/// 바뀐 것(문서 유무 · 최근 문서 · 테마 · 원격 이미지)을 항목에 반영한다.
pub fn refresh(app: &AppHandle) {
    let handles: SharedHandles = app.state::<SharedHandles>().inner().clone();
    let guard = handles.lock().unwrap();
    let Some(h) = guard.as_ref() else { return };
    let sh = shared(app);
    let tr = sh.tr;

    let has_doc = focused_label(app)
        .and_then(|l| sh.docs.lock().unwrap().get(&l).map(|d| d.path.is_some()))
        .unwrap_or(false);
    let s = sh.settings.lock().unwrap().clone();

    for it in [
        &h.save,
        &h.reveal,
        &h.copy_path,
        &h.print,
        &h.pdf,
        &h.edit,
        &h.toc,
        &h.find,
        &h.source,
    ] {
        let _ = it.set_enabled(has_doc);
    }
    for (i, name) in ["system", "light", "dark"].iter().enumerate() {
        let _ = h.theme[i].set_checked(s.theme == *name);
    }
    let _ = h.remote.set_checked(s.remote_images);
    let _ = h.keep_warm.set_checked(s.keep_warm);
    let _ = h.native_view.set_checked(s.native_view);
    #[cfg(windows)]
    let _ = h.autostart.set_checked(crate::autostart::is_enabled());

    // 최근 문서: 비우고 다시 채운다.
    if let Ok(old) = h.recent.items() {
        for o in old {
            let _ = h.recent.remove(&o);
        }
    }
    if s.recent.is_empty() {
        if let Ok(none) = MenuItemBuilder::new(tr.no_recent).enabled(false).build(app) {
            let _ = h.recent.append(&none);
        }
    } else {
        for (i, p) in s.recent.iter().enumerate() {
            let name = std::path::Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.clone());
            if let Ok(it) = MenuItemBuilder::with_id(format!("recent:{i}"), name).build(app) {
                let _ = h.recent.append(&it);
            }
        }
        if let Ok(sep) = tauri::menu::PredefinedMenuItem::separator(app) {
            let _ = h.recent.append(&sep);
        }
        if let Ok(clear) = MenuItemBuilder::with_id("clear_recent", tr.clear_recent).build(app) {
            let _ = h.recent.append(&clear);
        }
    }
}

/// 메뉴를 눌렀다. 동작은 '지금 초점이 있는 창'에 간다.
pub fn on_event(app: &AppHandle, ev: MenuEvent) {
    let id = ev.id().as_ref().to_string();
    let Some(label) = focused_label(app) else {
        return;
    };
    run_action(app, &label, &id);
}

/// 메뉴 항목 하나가 하는 일. 웹 창의 메뉴(muda)와 네이티브 뷰어 창의 메뉴가 같이 쓴다 — label 은 그 동작이 향하는 창.
pub fn run_action(app: &AppHandle, label: &str, id: &str) {
    let label = label.to_string();
    let id = id.to_string();
    let sh = shared(app);

    match id.as_str() {
        "open" => {
            let (app, label) = (app.clone(), label);
            tauri::async_runtime::spawn_blocking(move || open_dialog(&app, Some(&label)));
        }
        "save" | "print" | "pdf" | "edit" | "toc" | "find" | "source" => {
            send_command(app, &label, &id);
        }
        "close" => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            } else if let Some(h) = crate::native::handle_of(app, &label) {
                h.post(crate::preview::Cmd::Close);
            }
        }
        "quit" => crate::app::quit_all(app),
        "reveal" => {
            if let Some(p) = doc_path(app, &label) {
                let _ = tauri_plugin_opener::reveal_item_in_dir(p);
            }
        }
        "copy_path" => {
            if let Some(p) = doc_path(app, &label) {
                let _ = app.clipboard().write_text(p.to_string_lossy().into_owned());
            }
        }
        "zoom_in" => crate::cmd::step_zoom(app, 1),
        "zoom_out" => crate::cmd::step_zoom(app, -1),
        "zoom_reset" => crate::cmd::step_zoom(app, 0),
        "fullscreen" => {
            if let Some(w) = app.get_webview_window(&label) {
                let on = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!on);
            }
        }
        "remote" => {
            {
                let mut s = sh.settings.lock().unwrap();
                s.remote_images = !s.remote_images;
            }
            save_settings(app);
            broadcast_settings(app);
            let remote = sh.settings.lock().unwrap().remote_images;
            crate::native::each(app, |h| {
                h.post(crate::preview::Cmd::Settings {
                    remote_images: remote,
                })
            });
            refresh(app);
        }
        "autostart" => {
            // 켜면 로그인할 때마다 창 없이 대기하는 프로세스가 생긴다(메뉴 글이 그렇게 말한다). 레지스트리가 진실이다.
            #[cfg(windows)]
            {
                let _ = crate::autostart::set_enabled(!crate::autostart::is_enabled());
                refresh(app);
            }
        }
        "native_view" => {
            {
                let mut s = sh.settings.lock().unwrap();
                s.native_view = !s.native_view;
            }
            save_settings(app);
            refresh(app);
        }
        "keep_warm" => {
            {
                let mut s = sh.settings.lock().unwrap();
                s.keep_warm = !s.keep_warm;
            }
            save_settings(app);
            refresh(app);
        }
        "clear_recent" => {
            sh.settings.lock().unwrap().recent.clear();
            save_settings(app);
            refresh(app);
        }
        "set_default" => {
            // 윈도우는 기본 앱을 프로그램이 직접 바꾸지 못하게 막아 두었다. 그 설정 화면을 열어 준다.
            let _ = tauri_plugin_opener::open_url("ms-settings:defaultapps", None::<&str>);
        }
        "licenses" => {
            if let Ok(dir) = app.path().resource_dir() {
                let _ = tauri_plugin_opener::open_path(
                    dir.join("THIRD_PARTY_NOTICES.txt"),
                    None::<&str>,
                );
            }
        }
        "about" => {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            let v = app.package_info().version.to_string();
            let app2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                app2.dialog()
                    .message(format!("Marklet\nv{v}"))
                    .title("Marklet")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            });
        }
        other => {
            if let Some(name) = other.strip_prefix("theme:") {
                if theme_of(name).is_some() || name == "system" {
                    crate::cmd::apply_theme(app, name);
                }
            } else if let Some(idx) = other
                .strip_prefix("recent:")
                .and_then(|i| i.parse::<usize>().ok())
            {
                let p = sh.settings.lock().unwrap().recent.get(idx).cloned();
                if let Some(p) = p {
                    let path = std::path::PathBuf::from(&p);
                    if is_doc_path(&path) {
                        let (app, label) = (app.clone(), label);
                        tauri::async_runtime::spawn_blocking(move || {
                            open_file(&app, Some(&label), &path, false, false);
                        });
                    } else {
                        // 사라진 파일은 목록에서 뺀다.
                        sh.settings.lock().unwrap().recent.retain(|x| x != &p);
                        save_settings(app);
                        refresh(app);
                    }
                }
            }
        }
    }
}

fn doc_path(app: &AppHandle, label: &str) -> Option<std::path::PathBuf> {
    shared(app)
        .docs
        .lock()
        .unwrap()
        .get(label)
        .and_then(|d| d.path.clone())
}

pub fn broadcast_settings(app: &AppHandle) {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    for l in labels {
        send_settings(app, &l);
    }
}
