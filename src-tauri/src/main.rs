//! Marklet — Windows 마크다운 뷰어 (Tauri 판).
//!
//! 만들려는 것은 '마크다운을 위한 사진 뷰어'다. .md 를 더블클릭하면 그 문서만 보이는 창이 뜬다.
//! 화면 그리기는 TypeScript 렌더러(src/markdown/* · src/desktop/*)가 시스템의 WebView2 에서 한다.
//! 여기 Rust 는 그 바깥 — 창 · 파일 읽기/쓰기 · 인코딩 · 더블클릭 연결 · 감시 · 인쇄 — 를 맡는다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
#[cfg(windows)]
mod autostart;
mod cmd;
mod links;
mod menu;
mod native;
mod preview;
mod state;
mod strings;
mod text;
mod trace;
#[cfg(windows)]
mod webview;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use tauri::http;
use tauri::{Manager, UriSchemeContext};

use crate::app::{create_window, docs_from_argv, open_file, shared, Shared};
use crate::state::{data_dir_override, state_file, Settings};
use crate::text::{has_ext, IMAGE_EXTENSIONS};

fn mime_of(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn reply(status: u16, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .expect("response")
}

/// 문서가 참조하는 그림(상대 경로). 그림 확장자만 내준다.
/// 주소 모양: `http://marklet-local.localhost/f/<퍼센트 인코딩한 절대 경로>` (렌더러가 만든다).
///
/// ★ 네트워크 경로(UNC)는 지금 열려 있는 문서와 **같은 서버·공유**일 때만 내준다.
///   그 밖의 서버를 건드리면 열기만 해도 SMB 인증이 나간다.
fn image_protocol(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    req: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let not_found = || reply(404, "text/plain", b"not found".to_vec());
    let forbidden = || reply(403, "text/plain", b"forbidden".to_vec());

    let Some(enc) = req.uri().path().strip_prefix("/f/") else {
        return not_found();
    };
    let Ok(decoded) = percent_encoding::percent_decode_str(enc).decode_utf8() else {
        return not_found();
    };
    let path = PathBuf::from(decoded.replace('/', "\\"));
    if !has_ext(&path, &IMAGE_EXTENSIONS) {
        return forbidden();
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return forbidden();
    }
    if let Some(root) = links::unc_root(&path) {
        let app = ctx.app_handle();
        let allowed = shared(app).docs.lock().unwrap().values().any(|d| {
            d.path
                .as_deref()
                .and_then(|p| p.parent())
                .and_then(links::unc_root)
                .as_deref()
                == Some(root.as_str())
        });
        if !allowed {
            return forbidden();
        }
    }
    match std::fs::read(&path) {
        Ok(data) => reply(200, mime_of(&path), data),
        Err(_) => not_found(),
    }
}

fn main() {
    trace::mark("main");
    let args: Vec<String> = std::env::args().collect();
    // `--quit-warm`: 끝낼 것(숨겨 둔 채 기다리는 앱)이 없으면 아무것도 띄우지 않고 나간다.
    if args.iter().any(|a| a == "--quit-warm") && !preview::another_instance_running() {
        return;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let files = docs_from_argv(&args, &cwd);
    // `--background`: 로그인할 때 미리 켜는 것. 문서 없이 켜지고 창이 없다.
    let background = args.iter().any(|a| a == "--background");
    // WebView2 가 뜨는 동안(≈0.4초) 같은 문서를 네이티브로 먼저 그린다. 별도 스레드라 Tauri 시작을 늦추지 않는다.
    #[cfg(windows)]
    preview::start_initial(&files, native::initial_hooks());

    tauri::Builder::default()
        // ★ 단일 인스턴스 플러그인은 가장 먼저 등록해야 한다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 설치기가 업데이트 전에 부른다: 닫은 뒤 숨겨 두고 기다리는 중이면 끝낸다(창이 떠 있으면 건드리지 않는다).
            if argv.iter().any(|a| a == "--quit-warm") {
                app::quit_if_warm(app);
                return;
            }
            // 로그인 때 미리 켜는 것(`--background`)이 이미 떠 있는 앱에 또 왔다 — 할 일이 없다.
            if argv.iter().any(|a| a == "--background") {
                return;
            }
            // 이미 떠 있는 앱에서 또 더블클릭하면 새 창으로 연다.
            let files = docs_from_argv(&argv, Path::new(&cwd));
            if files.is_empty() {
                // 문서 없이 또 켰다: 숨겨 둔 창이 있으면 빈 창으로 보인다.
                if app::show_warm_empty(app) {
                    return;
                }
                native::focus_any(app);
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                for f in files {
                    open_file(&app, None, &f, false, false);
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("marklet-local", image_protocol)
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            cmd::ready,
            cmd::painted,
            cmd::swap,
            cmd::received,
            cmd::open_link,
            cmd::zoom,
            cmd::set_theme,
            cmd::run,
            cmd::set_dirty,
            cmd::save,
            cmd::print,
            cmd::open_external_url,
            cmd::toggle_menu,
        ])
        .setup(move |app| {
            trace::mark("setup");
            let handle = app.handle().clone();
            // 네이티브 창 스레드가 앱을 부를 수 있게 한다(첫 창은 Tauri 보다 먼저 떠 있다)
            let _ = native::APP.set(handle.clone());
            let over = data_dir_override();
            let data_dir = match &over {
                Some(d) => d.clone(),
                None => app.path().app_data_dir()?,
            };
            // Electron 판이 남긴 설정(%APPDATA%\marklet\state.json)이 있으면 처음 한 번 이어받는다(시험용 설정 폴더에서는 읽지 않는다).
            let electron_state = if over.is_some() {
                None
            } else {
                std::env::var_os("APPDATA")
                    .map(|a| PathBuf::from(a).join("marklet").join("state.json"))
            };
            let settings = Settings::load(&state_file(&data_dir), electron_state.as_deref());
            let locale = sys_locale::get_locale().unwrap_or_default();

            app.manage(Arc::new(Shared {
                settings: Mutex::new(settings),
                docs: Mutex::new(Default::default()),
                counter: AtomicUsize::new(0),
                tr: strings::pick(&locale),
                state_path: state_file(&data_dir),
                focused: Mutex::new(None),
                warm: Mutex::new(None),
                warm_gen: AtomicU64::new(0),
                quitting: AtomicBool::new(false),
                resident: AtomicBool::new(background),
                web_used: AtomicBool::new(false),
                spare_pending: AtomicBool::new(false),
            }));
            app.manage(menu::SharedHandles::default());
            trace::mark("state+manage");
            menu::init(&handle)?;
            trace::mark("menu");

            // ★ 첫 창만 여기서 만든다. 나머지는 이벤트 루프가 돈 뒤에 (이미 떠 있는 앱에 문서를 더 열 때와 같은 길로) 연다 —
            //   setup 안에서 창을 여럿 잇달아 만들면 둘째부터는 Tauri 가 주입하는 스크립트(__TAURI__)가 안 들어가거나
            //   IPC 가 영영 답을 못 받는 웹뷰가 생긴다(문서 셋을 한꺼번에 열었을 때 실측).
            let mut files = files.into_iter();
            if background && files.len() == 0 {
                // ★ 로그인할 때 미리 켠 것: 창 없이 부팅해 숨겨 둔다. 로그인 직후의 바쁜 때를 피해 조금 뒤에 시작한다.
                let h = handle.clone();
                // 쉬는 동안 미리보기에 쓸 것들(Direct2D · DirectWrite · 글꼴)도 프로세스에 미리 올려 둔다.
                #[cfg(windows)]
                preview::prewarm();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(
                        std::env::var("MARKLET_BACKGROUND_DELAY_MS")
                            .ok()
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(20_000),
                    ));
                    // 숨겨 둔 창이 없으면 하나 만든다(그 사이에 문서가 와서 이미 만들고 있으면 겹쳐 만들지 않는다).
                    app::ensure_spare(&h);
                });
                return Ok(());
            }
            // 첫 문서: 프로세스가 켜질 때 띄워 둔 창이 읽기만 하는 문서를 끝까지 맡으면 WebView2 를 만들지 않는다. 아니면 웹 창을 만들어 이어 붙인다.
            match files.next() {
                Some(f) => {
                    if native::open_new(&handle, &f).is_none() {
                        create_window(&handle, Some(f))?;
                    }
                }
                None => {
                    create_window(&handle, None)?;
                }
            }
            let rest: Vec<PathBuf> = files.collect();
            if !rest.is_empty() {
                tauri::async_runtime::spawn_blocking(move || {
                    for f in rest {
                        open_file(&handle, None, &f, false, false);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Marklet 을 시작하지 못했습니다")
        .run(|app, event| {
            // 마지막 웹 창이 닫혀 Tauri 가 끝내려 한다(code 가 없다) — 네이티브 뷰어 창이 남아 있으면 끝내지 않는다.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() && native::has_native(app) {
                    api.prevent_exit();
                }
            }
        });
}
