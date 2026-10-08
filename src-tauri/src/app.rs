//! 창 · 문서 · 저장 · 감시.
//!
//! 화면 그리기는 TypeScript 렌더러(src/desktop/main.ts)가 맡는다. 여기는 그 바깥,
//! 즉 창 · 파일 읽기/쓰기 · 인코딩 · 더블클릭 연결 · 감시만 한다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::state::{Bounds, Settings};
use crate::strings::Strings;
use crate::text::{apply_eol, decode_text, detect_eol, encode_text, has_ext, Enc, DOC_EXTENSIONS};

/// 이보다 큰 파일은 열지 않는다. 문서 하나가 이만큼 크면 마크다운이 아니다.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 렌더러 진입 HTML (루트의 desktop.html 을 vite 가 src-tauri/frontend/ 에 묶는다).
pub const ENTRY: &str = "desktop.html";

/// 저장이 끝난 뒤 이어서 할 일(닫기 · 다른 문서 열기)
pub enum After {
    Close,
    Open(PathBuf),
}

pub struct Doc {
    pub path: Option<PathBuf>,
    // ── 편집 · 저장: 파일을 읽을 때의 모양을 기억해 그대로 되돌려 쓴다
    pub enc: Enc,
    pub bom: bool,
    pub eol: &'static str,
    /// 마지막으로 읽거나 쓴 시점의 파일 수정 시각. 다른 곳에서 바뀌었는지 가린다.
    pub mtime: Option<SystemTime>,
    pub dirty: bool,
    pub after_save: Option<After>,
    pub force_close: bool,
    /// 렌더러가 부팅을 마쳤는가(그 전에 문서를 보내면 받을 귀가 없다)
    pub ready: bool,
    /// 창이 준비되면 열 파일
    pub pending: Option<PathBuf>,
    /// 이 창의 네이티브 미리보기(문서를 열러 만든 창에만 있다). 진짜 렌더가 그려지면 걷는다.
    pub preview: Option<crate::preview::Handle>,
    /// 이 문서를 WebView2 없이 끝까지 보여 주는 네이티브 뷰어 창(읽기만 하는 문서). 있으면 이 항목에는 웹 창이 없다.
    pub native: Option<crate::preview::Handle>,
    /// 웹 창이 문서를 그린 뒤 바로 할 일(네이티브 뷰어에서 편집 · 인쇄를 눌러 넘어온 경우: edit · print · pdf)
    pub command: Option<String>,
    /// 문서를 열러 만든 창이 아직 안 보이는가. 문서가 그려진 뒤에 보인다 — 그 전에 보이면 '파일을 끌어다 놓으세요' 안내가
    /// 잠깐 비친다(미리보기를 이어받는 첫 창은 `preview` 가 따로 맡는다).
    pub show_pending: bool,
    /// 이 창이 '닫은 뒤 숨겨 두었다가 다시 쓴' 횟수(빠른 시작). 너무 쌓이면 새 창으로 바꾼다.
    pub warm_uses: u32,
    /// 문서를 위해 만든 창이 아니다(로그인 때 미리 켠 것) — 부팅이 끝나면 보이지 않고 숨겨 둔 창이 된다.
    pub background: bool,
    /// 문서를 렌더러에 보냈다 / 렌더러가 받았다고 알려 왔다. 숨겨 두었던 창이 죽어 있는지 가리는 데 쓴다(watch_reuse).
    pub emitted: bool,
    pub received: bool,
    pub watcher: Option<Debouncer<RecommendedWatcher>>,
}

impl Doc {
    pub fn new(pending: Option<PathBuf>, preview: Option<crate::preview::Handle>) -> Doc {
        Doc {
            path: None,
            enc: Enc::Utf8,
            bom: false,
            eol: "\n",
            mtime: None,
            dirty: false,
            after_save: None,
            force_close: false,
            ready: false,
            show_pending: pending.is_some() && preview.is_none(),
            pending,
            preview,
            native: None,
            command: None,
            warm_uses: 0,
            background: false,
            emitted: false,
            received: false,
            watcher: None,
        }
    }
}

pub struct Shared {
    pub settings: Mutex<Settings>,
    /// 창 label → 그 창의 문서
    pub docs: Mutex<HashMap<String, Doc>>,
    pub counter: AtomicUsize,
    pub tr: &'static Strings,
    pub state_path: PathBuf,
    /// 마지막으로 초점을 가진 창(메뉴 동작이 향하는 곳)
    pub focused: Mutex<Option<String>>,
    /// 마지막 창을 닫으면서 숨겨 둔 창(빠른 시작). 다음 문서가 오면 이 창에 부팅 없이 바로 뜬다.
    pub warm: Mutex<Option<Warm>>,
    /// 숨겨 두거나 꺼낼 때마다 올린다 — 대기 시간이 끝나 앱을 끝내려는 타이머가 자기 차례가 아닌 걸 알아본다.
    pub warm_gen: AtomicU64,
    /// 끝내기를 눌렀다 — 마지막 창도 숨기지 않고 닫는다.
    pub quitting: AtomicBool,
    /// 숨겨 둘 여분 창을 만드는 중이다(스케줄됐거나 부팅 중). 하나만 만든다.
    pub spare_pending: AtomicBool,
    /// 로그인 때 미리 켜졌다(`--background`) — 숨겨 둔 창이 있어도 대기 시간이 지났다고 앱을 끝내지 않는다. 끝내기(Ctrl+Q)나 로그아웃으로만 끝난다.
    pub resident: AtomicBool,
    /// 웹 창을 한 번이라도 문서에 썼다 — 로그인 때 미리 켠 앱은 그 뒤에야 여분 웹 창을 만들어 둔다(네이티브 뷰어만 쓰는 동안은 WebView2 가 필요 없다).
    pub web_used: AtomicBool,
}

/// 숨겨 둔 창
pub struct Warm {
    pub label: String,
    pub uses: u32,
}

pub fn shared(app: &AppHandle) -> Arc<Shared> {
    app.state::<Arc<Shared>>().inner().clone()
}

#[derive(Serialize, Clone)]
struct DocPayload {
    path: String,
    name: String,
    dir: String,
    size: u64,
    content: String,
    encoding: &'static str,
    reload: bool,
    /// 첫 화면이 올라오면 `painted` 를 보내라(= 이 창은 그것을 기다리고 있다).
    announce: bool,
}

// ── 작은 도우미 ──────────────────────────────────────────────────────────

pub fn is_doc_path(p: &Path) -> bool {
    has_ext(p, &DOC_EXTENSIONS) && std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

pub fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 명령줄에서 문서 경로를 뽑는다. args[0] 은 실행 파일이다.
pub fn docs_from_argv(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| std::path::absolute(cwd.join(a)).ok())
        .filter(|p| is_doc_path(p))
        .collect()
}

pub fn error_box(app: &AppHandle, text: String) {
    app.dialog()
        .message(text)
        .title("Marklet")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// 웹 주소 · 메일만 기본 프로그램으로 보낸다. 그 밖의 것(.exe · file: …)은 열지 않는다.
pub fn open_external(url: &str) {
    let ok = ["http://", "https://", "mailto:", "tel:"]
        .iter()
        .any(|p| url.len() >= p.len() && url[..p.len()].eq_ignore_ascii_case(p));
    if ok {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
}

fn is_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

fn emit_command(app: &AppHandle, label: &str, payload: serde_json::Value) {
    let _ = app.emit_to(label, "command", payload);
}

pub fn send_command(app: &AppHandle, label: &str, name: &str) {
    emit_command(app, label, serde_json::json!({ "name": name }));
}

pub fn send_settings(app: &AppHandle, label: &str) {
    let s = shared(app).settings.lock().unwrap().clone();
    emit_command(
        app,
        label,
        serde_json::json!({
            "name": "settings",
            "value": { "theme": s.theme, "remoteImages": s.remote_images }
        }),
    );
}

pub fn theme_of(name: &str) -> Option<Theme> {
    match name {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

pub fn save_settings(app: &AppHandle) {
    let sh = shared(app);
    let s = sh.settings.lock().unwrap().clone();
    s.save(&sh.state_path);
}

/// 지금 초점이 있는 창(없으면 아무 창).
pub fn focused_label(app: &AppHandle) -> Option<String> {
    let sh = shared(app);
    if let Some(l) = sh.focused.lock().unwrap().clone() {
        if app.get_webview_window(&l).is_some() {
            return Some(l);
        }
    }
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels.into_iter().next()
}

// ── 창 ───────────────────────────────────────────────────────────────────

/// 아직 부팅 중인(렌더러가 `ready` 를 못 알린) 창들.
/// ★ 창을 여럿 한꺼번에 만들면 둘째부터 웹뷰가 망가진다 — Tauri 가 주입하는 스크립트(`__TAURI__`)가 안 들어가거나 IPC 가 영영
///   답을 못 받는다(문서 셋을 동시에 열었을 때 실측: 둘은 되고 셋부터 안 됐다). 그래서 앞 창이 부팅을 마친 뒤에 다음 창을 만든다.
///   (탐색기에서 문서 여러 개를 골라 열면 이 길로 한꺼번에 들어온다.)
struct Boot {
    booting: Mutex<Vec<String>>,
    cv: Condvar,
}
static BOOT: Boot = Boot {
    booting: Mutex::new(Vec::new()),
    cv: Condvar::new(),
};

/// 앞 창이 부팅을 마칠 때까지 기다린 뒤(최대 3초) 이 창을 '부팅 중' 으로 올린다.
fn boot_wait(label: &str) {
    let mut g = BOOT.booting.lock().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !g.is_empty() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        g = BOOT.cv.wait_timeout(g, left).unwrap().0;
    }
    g.push(label.to_string());
}

fn boot_done(label: &str) {
    BOOT.booting.lock().unwrap().retain(|l| l != label);
    BOOT.cv.notify_all();
}

/// 진짜 창이 첫 프레임을 올린 뒤에도 미리보기를 이만큼 더 둔다(finish_swap).
const PREVIEW_LINGER: Duration = Duration::from_millis(50);

/// 앞 창이 `ready` 를 알린 뒤에도 이만큼은 더 기다린다. 알린 *직후*에 다음 웹뷰를 만들면 그것도 망가졌다(0ms 에서 실패, 100ms 에서
/// 5창 × 3회 모두 성공 — 여유를 두어 250ms).
const BOOT_GAP: Duration = Duration::from_millis(250);

fn boot_done_after(label: &str) {
    let l = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(BOOT_GAP);
        boot_done(&l);
    });
}

/// 웹 창을 만들 때 이미 정해진 것들(네이티브 뷰어에서 넘어왔거나 창을 미리 띄워 둔 경우)
#[derive(Default)]
pub struct Pre {
    /// 이 창의 라벨(없으면 새로 정한다)
    pub label: Option<String>,
    /// 이미 떠 있는 네이티브 미리보기(없으면 문서를 열러 만든 창이 새로 띄운다)
    pub preview: Option<crate::preview::Handle>,
    /// 문서가 그려진 뒤 바로 할 일(edit · print · pdf)
    pub command: Option<String>,
    /// 웹 창의 라벨을 알려 줄 곳(미리보기를 일찍 닫았을 때 그 웹 창을 닫으려고 미리보기가 들고 있다)
    pub label_slot: Option<std::sync::Arc<Mutex<Option<String>>>>,
}

/// 새 창을 만든다. open 이 있으면 렌더러가 준비된 뒤에 그 문서를 연다.
pub fn create_window(app: &AppHandle, open: Option<PathBuf>) -> tauri::Result<String> {
    create_window_inner(app, open, false, Pre::default())
}

/// 문서를 WebView2 창에 연다: 숨겨 둔 창이 있으면 그것을(부팅이 없다), 없으면 새로 만든다.
/// preview 가 있으면 그 네이티브 창이 문서가 그려질 때까지 앞에 있다. 열었으면 창의 라벨.
pub fn open_web(
    app: &AppHandle,
    abs: &Path,
    preview: Option<crate::preview::Handle>,
    command: Option<String>,
    label_slot: Option<std::sync::Arc<Mutex<Option<String>>>>,
) -> Option<String> {
    let sh = shared(app);
    sh.web_used.store(true, Ordering::SeqCst);
    let mk_pre = |label: Option<String>| Pre {
        label,
        preview: preview.clone(),
        command: command.clone(),
        label_slot: label_slot.clone(),
    };
    if let Some(w) = take_warm(app) {
        let pre = mk_pre(Some(w.label.clone()));
        if let Some(l) = reuse_warm(app, w, Some(abs.to_path_buf()), pre) {
            return Some(l);
        }
        // 숨겨 둔 창이 이미 죽었다 — 아래에서 새로 만든다
    }
    match create_window_inner(app, Some(abs.to_path_buf()), false, mk_pre(None)) {
        Ok(l) => Some(l),
        Err(e) => {
            error_box(
                app,
                format!(
                    "{}

{e}",
                    file_name(abs)
                ),
            );
            None
        }
    }
}

/// 문서 없이 보이지 않는 창을 만든다 — 부팅이 끝나면 숨겨 둔 창(빠른 시작)이 된다. 로그인 때 미리 켤 때 쓴다.
fn create_hidden_window(app: &AppHandle) -> tauri::Result<String> {
    create_window_inner(app, None, true, Pre::default())
}

fn create_window_inner(
    app: &AppHandle,
    open: Option<PathBuf>,
    background: bool,
    pre: Pre,
) -> tauri::Result<String> {
    let sh = shared(app);
    let label = match &pre.label {
        Some(l) => l.clone(),
        None => {
            let n = sh.counter.fetch_add(1, Ordering::SeqCst) + 1;
            format!("w{n}")
        }
    };
    if let Some(slot) = &pre.label_slot {
        *slot.lock().unwrap() = Some(label.clone());
    }

    let (bounds, theme) = {
        let s = sh.settings.lock().unwrap();
        (s.bounds, theme_of(&s.theme))
    };
    let count = sh.docs.lock().unwrap().len() as f64;
    let b = bounds.unwrap_or(Bounds {
        width: 980.0,
        height: 900.0,
        x: None,
        y: None,
    });
    // 창을 여럿 열면 겹치지 않게 조금씩 비껴 놓는다.
    let offset = count * 28.0;

    // 문서를 열러 만든 창이면 네이티브 미리보기를 띄운다(첫 창은 프로세스가 켜질 때 이미 띄워 둔 것을 이어받는다).
    #[cfg(windows)]
    let preview = match pre.preview.clone() {
        Some(h) => Some(h),
        None => open
            .as_ref()
            .and_then(|p| spawn_preview(app, &label, p, offset)),
    };
    #[cfg(not(windows))]
    let preview: Option<crate::preview::Handle> = None;
    {
        let mut doc = Doc::new(open, preview);
        doc.background = background;
        doc.command = pre.command.clone();
        sh.docs.lock().unwrap().insert(label.clone(), doc);
    }

    let nav_app = app.clone();
    let mut wb = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(ENTRY.into()))
        .title("Marklet")
        .inner_size(b.width, b.height)
        .min_inner_size(360.0, 280.0)
        .visible(false)
        .zoom_hotkeys_enabled(false)
        .theme(theme)
        // 앱 밖으로 가는 이동은 막고, 웹 주소면 기본 브라우저로 보낸다. 앱 창 안에서 남의 페이지를 열지 않는다.
        .on_navigation(move |url| {
            if is_app_url(url) {
                true
            } else {
                let _ = &nav_app;
                open_external(url.as_str());
                false
            }
        })
        .on_new_window(|url, _features| {
            open_external(url.as_str());
            NewWindowResponse::Deny
        });
    #[cfg(windows)]
    {
        wb = wb.additional_browser_args(crate::webview::BROWSER_ARGS);
    }
    wb = match (b.x, b.y) {
        (Some(x), Some(y)) => wb.position(x + offset, y + offset),
        _ => wb.center(),
    };
    boot_wait(&label);
    crate::trace::mark(&format!("window-build {label}"));
    let win = match wb.build() {
        Ok(w) => w,
        Err(e) => {
            boot_done(&label);
            return Err(e);
        }
    };
    crate::trace::mark(&format!("window-built {label}"));

    #[cfg(windows)]
    crate::webview::harden(&win);
    // 메뉴 막대는 Alt 를 눌러야 나온다(사진 뷰어처럼 문서만 보이게).
    let _ = win.hide_menu();

    let app2 = app.clone();
    let l2 = label.clone();
    win.on_window_event(move |ev| on_window_event(&app2, &l2, ev));
    Ok(label)
}

/// 이 문서의 네이티브 미리보기를 띄운다(웹 창이 뜨는 동안만 있는 것 — 네이티브 뷰어가 아니다).
#[cfg(windows)]
fn spawn_preview(
    app: &AppHandle,
    label: &str,
    path: &Path,
    offset: f64,
) -> Option<crate::preview::Handle> {
    let sh = shared(app);
    let mut opts = crate::preview::Opts::from_settings(
        &sh.settings.lock().unwrap(),
        offset,
        crate::native::korean(app),
    );
    // 이 문서는 웹 창이 그린다 — 미리보기도 끝까지 맡지 않는다
    opts.native = false;
    // 진짜 창이 뜨기 전에 사용자가 미리보기를 닫으면 이 문서의 창을 닫는다(창이 아직 없으면 뜨는 대로 닫힌다: finish_swap).
    let (app2, l2) = (app.clone(), label.to_string());
    let on_close: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
        if let Some(w) = app2.get_webview_window(&l2) {
            let _ = w.close();
        }
    });
    crate::preview::open(path, opts, on_close, crate::native::NativeHooks::new(label))
}

fn on_window_event(app: &AppHandle, label: &str, ev: &WindowEvent) {
    match ev {
        WindowEvent::Focused(true) => {
            *shared(app).focused.lock().unwrap() = Some(label.to_string());
            crate::menu::refresh(app);
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            // 끌어다 놓은 첫 문서를 이 창에 연다.
            if let Some(p) = paths.iter().find(|p| is_doc_path(p)).cloned() {
                let (app, label) = (app.clone(), label.to_string());
                tauri::async_runtime::spawn_blocking(move || {
                    open_file(&app, Some(&label), &p, false, false);
                });
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            let sh = shared(app);
            let must_ask = {
                let docs = sh.docs.lock().unwrap();
                docs.get(label)
                    .map(|d| d.dirty && !d.force_close)
                    .unwrap_or(false)
            };
            if must_ask {
                // ★ 저장하지 않은 편집이 있으면 창을 닫지 않고 먼저 묻는다. 안 묻으면 쓰던 글이 소리 없이 사라진다.
                api.prevent_close();
                let (app, label) = (app.clone(), label.to_string());
                tauri::async_runtime::spawn_blocking(move || {
                    ask_save_then(&app, &label, After::Close);
                });
            } else if should_go_warm(app, label) {
                // ★ 마지막 창이면 닫지 않고 숨겨 둔다(빠른 시작). 웹뷰가 떠 있는 채라 다음 문서가 부팅 없이 바로 뜬다.
                api.prevent_close();
                go_warm(app, label);
            } else {
                remember_bounds(app, label);
            }
        }
        WindowEvent::Destroyed => {
            let sh = shared(app);
            // 미리보기가 아직 떠 있는 채로 창이 없어졌다(열기 실패 · 닫음) — 미리보기도 걷는다.
            boot_done(label);
            let gone = sh.docs.lock().unwrap().remove(label);
            if let Some(h) = gone.and_then(|d| d.preview) {
                h.close();
            }
            let mut f = sh.focused.lock().unwrap();
            if f.as_deref() == Some(label) {
                *f = None;
            }
            drop(f);
            crate::menu::refresh(app);
        }
        _ => {}
    }
}

fn remember_bounds(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    if win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(size), Ok(pos), Ok(scale)) =
        (win.inner_size(), win.outer_position(), win.scale_factor())
    else {
        return;
    };
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
    {
        let sh = shared(app);
        sh.settings.lock().unwrap().bounds = Some(Bounds {
            width: w,
            height: h,
            x: Some(x),
            y: Some(y),
        });
    }
    save_settings(app);
}

// ── 빠른 시작: 마지막 창을 숨겨 두었다가 다시 쓴다 ──────────────────────────────

/// 숨겨 둔 채 기다리는 시간. 이 안에 다음 문서가 안 오면 앱을 끝낸다. (시험용: MARKLET_WARM_SECONDS)
fn warm_linger() -> Duration {
    let secs = std::env::var("MARKLET_WARM_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(300);
    Duration::from_secs(secs)
}

/// 같은 창을 이만큼 다시 쓰면 새 창으로 바꾼다(웹뷰 안에 쌓이는 것이 끝없이 늘지 않게).
const MAX_WARM_USES: u32 = 20;

/// 다시 쓰는 창이 문서를 보냈는데도 이 안에 받았다는 알림(`received`)이 없으면 렌더러가 죽은 것으로 보고 새 창으로 바꾼다.
/// (느리게 그리는 것은 죽은 것이 아니다 — 그리는 데 걸리는 시간은 보지 않는다.)
const REUSE_WATCHDOG: Duration = Duration::from_millis(1500);

/// 이 창을 닫을 때 닫지 않고 숨겨 둘 것인가: 마지막 창이고, 설정이 켜져 있고, 멀쩡히 부팅된 창일 때만.
fn should_go_warm(app: &AppHandle, label: &str) -> bool {
    if std::env::var_os("MARKLET_NO_WARM").is_some() {
        return false;
    }
    let sh = shared(app);
    if sh.quitting.load(Ordering::SeqCst)
        || !sh.settings.lock().unwrap().keep_warm
        || sh.warm.lock().unwrap().is_some()
    {
        return false;
    }
    let docs = sh.docs.lock().unwrap();
    docs.len() == 1
        && docs
            .get(label)
            .map(|d| d.ready && d.warm_uses < MAX_WARM_USES)
            .unwrap_or(false)
}

/// 마지막 창을 숨겨 둔다. 문서 상태는 치우고(감시 포함) 렌더러도 맨 처음 모습으로 되돌린다.
fn go_warm(app: &AppHandle, label: &str) {
    let sh = shared(app);
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    // 한 번도 안 보인 창(로그인 때 미리 켠 것)의 자리는 저장하지 않는다.
    if win.is_visible().unwrap_or(false) {
        remember_bounds(app, label);
    }
    let gone = sh.docs.lock().unwrap().remove(label);
    let uses = gone.as_ref().map(|d| d.warm_uses).unwrap_or(0);
    // 미리보기가 아직 떠 있는 채로 닫았다(첫 화면이 올라오기 전) — 미리보기도 걷는다.
    if let Some(p) = gone.and_then(|d| d.preview) {
        p.close();
    }
    send_command(app, label, "reset");
    // 다음 사용자가 이 창을 처음 보는 것처럼: 전체 화면 · 최대화 · 메뉴 막대를 원래대로(저장된 크기와 자리는 reuse 때 다시 놓는다).
    let _ = win.set_fullscreen(false);
    let _ = win.unmaximize();
    let _ = win.hide_menu();
    let _ = win.set_title("Marklet");
    let _ = win.hide();
    // ★ 미리보기 뒤에 Win32 로 직접 보였던 창은 tao 가 '아직 안 보임'으로 알고 있어 hide() 가 아무 일도 안 한다 — 직접 숨긴다.
    #[cfg(windows)]
    crate::webview::force_hide(&win);
    #[cfg(windows)]
    crate::webview::set_memory_low(&win, true);
    {
        let mut f = sh.focused.lock().unwrap();
        if f.as_deref() == Some(label) {
            *f = None;
        }
    }
    let gen = {
        let mut w = sh.warm.lock().unwrap();
        *w = Some(Warm {
            label: label.to_string(),
            uses,
        });
        sh.warm_gen.fetch_add(1, Ordering::SeqCst) + 1
    };
    crate::menu::refresh(app);
    // 숨겨 두는 동안 렌더러가 표본 문서를 한 번 그려 보게 한다 — 수식 · 코드 색 조각과 글꼴을 올리고 코드를 데운다. 다음 문서가
    // 그만큼 빨리 그려진다(로그인 때 미리 켠 앱에서 첫 문서 진짜 렌더 315 → 162 ms). 그 사이에 문서가 오면 건드리지 않는다.
    warm_up_renderer(app, label);
    {
        let (app3, l3) = (app.clone(), label.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            let sh = shared(&app3);
            let still = sh
                .warm
                .lock()
                .unwrap()
                .as_ref()
                .map(|w| w.label == l3)
                .unwrap_or(false)
                && sh.warm_gen.load(Ordering::SeqCst) == gen;
            if still {
                send_command(&app3, &l3, "reset");
            }
        });
    }
    sh.spare_pending.store(false, Ordering::SeqCst);
    start_linger(app, gen);
}

/// 기다리는 동안 아무도 안 쓰면 앱을 끝낸다(다른 창이 떠 있으면 숨겨 둔 창만 버린다).
fn start_linger(app: &AppHandle, gen: u64) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(warm_linger());
        let sh = shared(&app2);
        // 로그인 때 미리 켠 앱은 대기 시간으로 끝나지 않는다.
        if sh.resident.load(Ordering::SeqCst) {
            return;
        }
        let w = {
            let mut g = sh.warm.lock().unwrap();
            if g.is_some() && sh.warm_gen.load(Ordering::SeqCst) == gen {
                g.take()
            } else {
                None
            }
        };
        let Some(w) = w else { return };
        // ★ 그 사이에 다른 창이 떴으면(닫는 순간에 다른 문서가 들어온 경우) 앱을 끝내면 안 된다 — 숨겨 둔 창만 버린다.
        if sh.docs.lock().unwrap().is_empty() {
            app2.exit(0);
        } else if let Some(win) = app2.get_webview_window(&w.label) {
            let _ = win.destroy();
        }
    });
}

/// 숨겨 둔 창을 꺼낸다(대기 타이머도 이것으로 무효가 된다). 창이 이미 없으면 None.
fn take_warm(app: &AppHandle) -> Option<Warm> {
    let sh = shared(app);
    let w = {
        let mut g = sh.warm.lock().unwrap();
        let w = g.take()?;
        sh.warm_gen.fetch_add(1, Ordering::SeqCst);
        w
    };
    app.get_webview_window(&w.label).map(|_| w)
}

/// 숨겨 둔 창에 문서를 띄운다(path 가 None 이면 빈 창으로 보인다). 새 창을 만들 때와 같은 순서를 밟되 웹뷰 부팅이 없다.
fn reuse_warm(app: &AppHandle, w: Warm, path: Option<PathBuf>, pre: Pre) -> Option<String> {
    let sh = shared(app);
    let label = w.label.clone();
    let win = app.get_webview_window(&label)?;
    crate::trace::mark(&format!("warm-reuse {label}"));
    if let Some(slot) = &pre.label_slot {
        *slot.lock().unwrap() = Some(label.clone());
    }
    // 이미 열린 창이 있으면 겹치지 않게 조금씩 비껴 놓는다(새 창을 만들 때와 같다).
    let offset = sh.docs.lock().unwrap().len() as f64 * 28.0;

    #[cfg(windows)]
    let preview = match pre.preview.clone() {
        Some(h) => Some(h),
        None => path
            .as_ref()
            .and_then(|p| spawn_preview(app, &label, p, offset)),
    };
    #[cfg(not(windows))]
    let preview: Option<crate::preview::Handle> = None;

    let mut doc = Doc::new(path.clone(), preview.clone());
    doc.ready = true; // 웹뷰는 이미 부팅되어 있다
    doc.pending = None;
    doc.command = pre.command.clone();
    doc.warm_uses = w.uses + 1;
    sh.docs.lock().unwrap().insert(label.clone(), doc);

    // 창 모양: 저장된 자리와 크기(첫 창과 같다). 미리보기가 있으면 그 자리를 따라간다.
    let (bounds, zoom) = {
        let s = sh.settings.lock().unwrap();
        (s.bounds, s.zoom)
    };
    place_window(&win, bounds, offset);
    #[cfg(windows)]
    crate::webview::set_memory_low(&win, false);
    let _ = win.set_zoom(zoom);
    send_settings(app, &label);
    crate::menu::refresh(app);

    match (&preview, &path) {
        (Some(p), _) => {
            #[cfg(windows)]
            show_behind_preview(&win, p);
            #[cfg(not(windows))]
            let _ = p;
        }
        // 미리보기 없는 문서(.txt 등)는 그려진 뒤에 보인다(finish_swap).
        (None, Some(_)) => {}
        // 문서 없이 켰다: 안내 화면을 그대로 보인다.
        (None, None) => {
            let _ = win.show();
            crate::trace::mark(&format!("shown {label}"));
            let _ = win.set_focus();
        }
    }
    if let Some(p) = path {
        arm_swap_fallback(app, &label);
        watch_reuse(app, &label, p.clone());
        open_file(app, Some(&label), &p, false, true);
    }
    Some(label)
}

fn place_window(win: &tauri::WebviewWindow, bounds: Option<Bounds>, offset: f64) {
    let b = bounds.unwrap_or(Bounds {
        width: 980.0,
        height: 900.0,
        x: None,
        y: None,
    });
    let _ = win.set_size(tauri::LogicalSize::new(b.width, b.height));
    match (b.x, b.y) {
        (Some(x), Some(y)) => {
            let _ = win.set_position(tauri::LogicalPosition::new(x + offset, y + offset));
        }
        _ => {
            let _ = win.center();
        }
    }
}

/// 다시 쓴 창이 첫 화면을 못 그리면(숨겨 두는 동안 렌더러가 죽었을 수 있다) 새 창으로 바꾼다.
/// ★ 새 창을 먼저 만들고 망가진 창을 버린다 — 마지막 창이 사라지면 Tauri 가 앱을 끝내 버린다.
fn watch_reuse(app: &AppHandle, label: &str, path: PathBuf) {
    let (app2, l2) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(REUSE_WATCHDOG);
        let sh = shared(&app2);
        let dead = sh
            .docs
            .lock()
            .unwrap()
            .get(&l2)
            .map(|d| d.emitted && !d.received)
            .unwrap_or(false);
        if !dead {
            return;
        }
        if let Some(d) = sh.docs.lock().unwrap().remove(&l2) {
            if let Some(p) = d.preview {
                p.close();
            }
        }
        open_file(&app2, None, &path, false, false);
        if let Some(w) = app2.get_webview_window(&l2) {
            let _ = w.destroy();
        }
    });
}

/// 숨겨 둔 창의 렌더러에 표본 문서(표 · 코드 · 수식 · 각주 …)를 한 번 그려 보게 한다. 결과는 아무도 안 본다 — `go_warm` 의 `reset` 이 치운다.
/// (Mermaid 는 일부러 뺐다. 600KB 가 넘는 조각이라 Mermaid 문서를 열 때만 받는 편이 낫다.)
fn warm_up_renderer(app: &AppHandle, label: &str) {
    let content = WARMUP_DOC.to_string();
    let payload = DocPayload {
        path: String::new(),
        name: "warm-up.md".into(),
        dir: String::new(),
        size: content.len() as u64,
        content,
        encoding: "UTF-8",
        reload: false,
        announce: false,
    };
    let _ = app.emit_to(label, "document", payload);
}

const WARMUP_DOC: &str = "---\ntitle: warm-up\n---\n\n# 제목\n\n본문 **굵게** *기울임* `코드` [링크](#a) $x^2$[^1]\n\n| 가 | 나 |\n| :-- | --: |\n| 1 | 2 |\n\n```ts\nconst a: number = 1; // 주석\n```\n\n$$\n\\frac{1}{2}\n$$\n\n- [x] 하나\n- [ ] 둘\n\n> 인용\n\n[^1]: 각주\n";

/// 로그인 때 미리 켠 앱(`resident`)은 숨겨 둔 창을 쓰고 나면 곧 다음 것을 미리 만들어 둔다 — 문서를 몇 개를 열든 늘 부팅 없이 뜬다.
/// 새 창을 만들면 웹뷰를 새로 올리고 코드를 처음부터 데워야 한다(진짜 렌더 427 ms). 숨겨 둔 창은 이미 부팅해서 한 번 그려 본 창이라 160 ms 쯤이다.
/// 대가는 웹뷰 하나가 더 있는 것이다(개인 메모리 +166 MB) — 그래서 **미리 켜 두기를 직접 켠 사용자만** 치른다.
/// (창을 닫은 뒤에 잠깐 기다리는 빠른 시작은 이 여분을 만들지 않는다: 문서를 여럿 여는 사람에게도 창마다 하나씩 더 드는 값이 너무 크다.)
pub fn ensure_spare(app: &AppHandle) {
    let sh = shared(app);
    let wanted = |sh: &Shared| {
        sh.resident.load(Ordering::SeqCst)
            && !sh.quitting.load(Ordering::SeqCst)
            && sh.warm.lock().unwrap().is_none()
            // 네이티브 뷰어가 읽기만 하는 문서를 맡는 동안은 여분 웹 창이 필요 없다(개인 메모리 +166 MB) — 웹 창을 한 번 쓴 뒤에야 만들어 둔다
            && (sh.web_used.load(Ordering::SeqCst)
                || !crate::preview::native_on(sh.settings.lock().unwrap().native_view))
    };
    if !wanted(&sh) {
        return;
    }
    if sh.spare_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        // 방금 그린 창이 한가해질 때까지 기다린다(웹뷰를 올리는 동안 메인 스레드가 잠깐 묶인다).
        std::thread::sleep(Duration::from_millis(800));
        let sh = shared(&app2);
        if wanted(&sh) {
            crate::trace::mark("spare-create");
            if create_hidden_window(&app2).is_err() {
                sh.spare_pending.store(false, Ordering::SeqCst);
                return;
            }
        } else {
            sh.spare_pending.store(false, Ordering::SeqCst);
            return;
        }
        // 부팅이 끝나 숨겨 둔 창이 되면(go_warm) 거기서 풀린다. 끝내 안 되면 여기서 푼다.
        std::thread::sleep(Duration::from_secs(6));
        sh.spare_pending.store(false, Ordering::SeqCst);
    });
}

/// 문서 없이 또 켰을 때: 숨겨 둔 창이 있으면 빈 창으로 보인다. 있었으면 true.
pub fn show_warm_empty(app: &AppHandle) -> bool {
    take_warm(app)
        .and_then(|w| reuse_warm(app, w, None, Pre::default()))
        .is_some()
}

/// 앱을 끝낸다(메뉴 '끝내기'). 열린 창을 하나씩 닫아 — 저장하지 않은 편집은 닫을 때의 확인을 그대로 거친다 — 마지막 창이 닫히면 끝난다.
/// 숨겨 둔 창만 있으면 바로 끝낸다.
pub fn quit_all(app: &AppHandle) {
    let sh = shared(app);
    sh.quitting.store(true, Ordering::SeqCst);
    sh.warm_gen.fetch_add(1, Ordering::SeqCst);
    sh.warm.lock().unwrap().take();
    let labels: Vec<String> = sh.docs.lock().unwrap().keys().cloned().collect();
    if labels.is_empty() {
        app.exit(0);
        return;
    }
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.close();
        } else if let Some(h) = crate::native::handle_of(app, &l) {
            h.post(crate::preview::Cmd::Close);
        }
    }
}

/// 숨겨 둔 창만 남은 채 기다리는 중이면 앱을 끝낸다(설치기가 업데이트 전에 부른다: `Marklet.exe --quit-warm`).
pub fn quit_if_warm(app: &AppHandle) {
    let sh = shared(app);
    if sh.warm.lock().unwrap().is_some() && sh.docs.lock().unwrap().is_empty() {
        app.exit(0);
    }
}

/// 창이 첫 화면을 그렸다는 알림이 안 와도 4초 뒤에는 어쨌든 넘긴다(finish_swap).
fn arm_swap_fallback(app: &AppHandle, label: &str) {
    let (app2, l2) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        finish_swap(&app2, &l2);
    });
}

/// 네이티브 미리보기에서 진짜 창으로 넘긴다: 미리보기와 같은 자리에 창을 놓고 보인 뒤 미리보기를 걷는다. 한 번만 일어난다.
pub fn finish_swap(app: &AppHandle, label: &str) {
    // 연구용: 미리보기를 걷지 않고 그대로 둔다(미리보기 화면을 떠서 렌더러와 맞대 보려는 것).
    if std::env::var_os("MARKLET_PREVIEW_HOLD").is_some() {
        return;
    }
    let sh = shared(app);
    let (preview, waiting) = sh
        .docs
        .lock()
        .unwrap()
        .get_mut(label)
        .map(|d| {
            (
                d.preview.take(),
                std::mem::replace(&mut d.show_pending, false),
            )
        })
        .unwrap_or((None, false));
    let Some(win) = app.get_webview_window(label) else {
        // 창이 없다(열기 실패 · 이미 닫힘) — 떠 있는 미리보기가 있으면 걷는다.
        if let Some(p) = preview {
            p.close();
        }
        return;
    };
    let Some(preview) = preview else {
        // 미리보기와 상관없는 창(미리보기가 없는 실행 · .txt …): 문서가 그려졌으니 이제 보인다.
        if waiting {
            let _ = win.show();
            crate::trace::mark(&format!("shown {label}"));
            let _ = win.set_focus();
            run_pending_command(app, label);
            ensure_spare(app);
        }
        return;
    };
    // 사용자가 진짜 창이 뜨기 전에 미리보기를 닫았다 — 그 문서를 닫겠다는 뜻이다. 창을 보이지 않고 닫는다.
    if preview.close_requested() {
        preview.close();
        let _ = win.close();
        return;
    }
    // 미리보기가 그동안 옮겨지거나 크기가 바뀌었을 수 있다 — 마지막 자리를 따라간다.
    #[cfg(windows)]
    if let Some(g) = preview.geometry() {
        let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
        let _ = win.set_size(tauri::PhysicalSize::new(g.w, g.h));
    }
    // 보통은 on_ready 가 이미 미리보기 뒤에 보여 두었다. 그러지 못했을 때만 여기서 보인다.
    if !win.is_visible().unwrap_or(false) {
        let _ = win.show();
    }
    crate::trace::mark(&format!("shown {label}"));
    // 미리보기는 잠깐 더 둔다 — 진짜 창이 방금 올린 프레임을 DWM 이 합성할 틈이다. 바로 걷으면 드물게(34회 중 1회) 빈 프레임이 비쳤다.
    // 미리보기가 가린 채라 사용자 눈에는 아무 일도 없다.
    // ★ 초점(set_focus)은 걷은 **뒤에** 준다 — 먼저 주면 진짜 창이 그 순간 미리보기 위로 올라와 이 틈이 의미가 없어진다.
    // ★ show() 는 이미 보이는 창에는 효과가 없지만, 미리보기 뒤에 Win32 로 직접 보인 창에 대해 tao 가 갖고 있는 '안 보임' 기록을
    //   바로잡는다(그 기록이 틀린 채면 나중에 hide() 가 아무 일도 안 한다).
    let (app2, l2) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(PREVIEW_LINGER);
        preview.close();
        // 그 사이에 창을 닫아 숨겨 두었으면(빠른 시작) 다시 보이면 안 된다.
        if !shared(&app2).docs.lock().unwrap().contains_key(&l2) {
            return;
        }
        if let Some(w) = app2.get_webview_window(&l2) {
            let _ = w.show();
            let _ = w.set_focus();
        }
        run_pending_command(&app2, &l2);
        ensure_spare(&app2);
    });
}

/// 네이티브 뷰어에서 편집 · 인쇄 · PDF 를 눌러 넘어온 창이 문서를 그렸다 — 눌렀던 일을 이제 한다.
fn run_pending_command(app: &AppHandle, label: &str) {
    let cmd = shared(app)
        .docs
        .lock()
        .unwrap()
        .get_mut(label)
        .and_then(|d| d.command.take());
    if let Some(c) = cmd {
        send_command(app, label, &c);
    }
}

/// 진짜 창을 미리보기와 같은 자리에 놓고 그 바로 뒤에 보인다(가려진 채로 그리게 한다).
#[cfg(windows)]
fn show_behind_preview(win: &tauri::WebviewWindow, p: &crate::preview::Handle) {
    if let Some(g) = p.geometry() {
        let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
        let _ = win.set_size(tauri::PhysicalSize::new(g.w, g.h));
    }
    if let Ok(h) = win.hwnd() {
        p.show_behind(h.0 as isize);
    }
}

/// 렌더러가 첫 블록을 그렸다고 알렸다. 반환값은 렌더러가 이어받아야 할 읽는 자리(CSS px)다 — 0 이면 바로 넘긴다.
/// 미리보기에서 이미 내려 읽고 있었다면(큰 문서 · 느린 PC) 렌더러가 그 자리로 간 뒤 `swap` 으로 넘기게 한다.
pub fn painted(app: &AppHandle, label: &str) -> f64 {
    let y = shared(app)
        .docs
        .lock()
        .unwrap()
        .get(label)
        .and_then(|d| d.preview.as_ref().map(|p| p.scroll_y()))
        .unwrap_or(0.0);
    if y > 0.5 {
        return y as f64;
    }
    finish_swap(app, label);
    0.0
}

/// 렌더러가 부팅을 마쳤다 — 설정을 보내고, 창을 보이고, 기다리던 문서를 연다.
pub fn on_ready(app: &AppHandle, label: &str) {
    crate::trace::mark(&format!("ready {label}"));
    boot_done_after(label);
    let sh = shared(app);
    let (zoom, pending) = {
        let zoom = sh.settings.lock().unwrap().zoom;
        let mut docs = sh.docs.lock().unwrap();
        let pending = docs.get_mut(label).and_then(|d| {
            d.ready = true;
            d.pending.take()
        });
        (zoom, pending)
    };
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_zoom(zoom);
        send_settings(app, label);
        // 문서를 위해 만든 창이 아니다(로그인 때 미리 켠 것) — 부팅이 끝났으니 보이지 않고 숨겨 둔 창으로 올린다.
        if sh
            .docs
            .lock()
            .unwrap()
            .get(label)
            .map(|d| d.background)
            .unwrap_or(false)
        {
            go_warm(app, label);
            return;
        }
        let (preview, waiting) = sh
            .docs
            .lock()
            .unwrap()
            .get(label)
            .map(|d| (d.preview.clone(), d.show_pending))
            .unwrap_or((None, false));
        // 사용자가 진짜 창이 뜨기도 전에 미리보기를 닫았다 — 이 창은 보이지 않고 닫는다.
        if preview
            .as_ref()
            .map(|p| p.close_requested())
            .unwrap_or(false)
        {
            let _ = win.close();
            return;
        }
        if preview.is_some() || waiting {
            // ★ 문서가 그려지기 전에는 이 창을 앞에 보이지 않는다 — 문서 없는 화면('파일을 끌어다 놓으세요')이 비친다.
            //   렌더러가 첫 블록을 그린 뒤 `painted` 를 알리면 그때 보인다(finish_swap). 안 오면 4초 뒤 어쨌든 보인다.
            //   · 네이티브 미리보기가 떠 있으면(첫 창) 이 창을 미리보기 **뒤에** 보여 두고 거기서 그리게 한다. 미리 보여 두어야
            //     미리보기를 걷는 순간 이미 올라가 있는 화면이 드러난다.
            #[cfg(windows)]
            if let Some(p) = &preview {
                show_behind_preview(&win, p);
            }
            arm_swap_fallback(app, label);
        } else {
            let _ = win.show();
            crate::trace::mark(&format!("shown {label}"));
            let _ = win.set_focus();
        }
    }
    if let Some(p) = pending {
        let (app, label) = (app.clone(), label.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            open_file(&app, Some(&label), &p, false, true);
        });
    }
}

// ── 문서 열기 ────────────────────────────────────────────────────────────

/// 창 제목 = 파일 이름. 저장하지 않은 편집이 있으면 앞에 ● 를 붙인다.
pub fn update_title(app: &AppHandle, label: &str) {
    let sh = shared(app);
    let title = {
        let docs = sh.docs.lock().unwrap();
        match docs
            .get(label)
            .and_then(|d| d.path.as_ref().map(|p| (p, d.dirty)))
        {
            Some((p, dirty)) => format!("{}{}", if dirty { "● " } else { "" }, file_name(p)),
            None => return,
        }
    };
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_title(&title);
    }
}

/// 파일 하나를 창에 띄운다. label 이 없거나 닫혔으면 새 창을 만든다(그 창은 준비되면 이 파일을 연다).
/// 블로킹이다 — 대화상자가 뜰 수 있으므로 메인 스레드에서 부르지 마라.
pub fn open_file(
    app: &AppHandle,
    label: Option<&str>,
    path: &Path,
    reload: bool,
    force: bool,
) -> Option<String> {
    let sh = shared(app);
    let abs = std::path::absolute(path).ok()?;
    if !is_doc_path(&abs) {
        return None;
    }

    // 이미 떠 있는 네이티브 뷰어 창에 연다(링크 · 다시 읽기 · 최근 문서 · 끌어다 놓기)
    if let Some((l, h)) =
        label.and_then(|l| crate::native::handle_of(app, l).map(|h| (l.to_string(), h)))
    {
        return crate::native::reopen(app, &l, &h, &abs, reload);
    }
    let target = match label.filter(|l| app.get_webview_window(l).is_some()) {
        Some(l) => l.to_string(),
        // 새 창: 네이티브 뷰어가 끝까지 맡을 수 있는 문서는 WebView2 없이, 아니면 숨겨 둔 창을 쓰거나 새로 만든다(native::open_new).
        None => return crate::native::open_new(app, &abs),
    };

    // ★ 편집 중인 창에 다른 파일을 열면 쓰던 글이 사라진다. 먼저 묻는다(자동 갱신은 이 길로 오지 않는다).
    {
        let docs = sh.docs.lock().unwrap();
        let d = docs.get(&target)?;
        if d.dirty && !reload && d.path.as_deref() != Some(abs.as_path()) && !force {
            drop(docs);
            ask_save_then(app, &target, After::Open(abs));
            return None;
        }
    }

    let meta = match std::fs::metadata(&abs) {
        Ok(m) => m,
        Err(e) => {
            error_box(app, format!("{}\n\n{e}", file_name(&abs)));
            return None;
        }
    };
    if meta.len() > MAX_BYTES {
        error_box(app, format!("{}: file is too large.", file_name(&abs)));
        return None;
    }
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => {
            error_box(app, format!("{}\n\n{e}", file_name(&abs)));
            return None;
        }
    };
    let dec = decode_text(&bytes);
    let eol = detect_eol(&dec.text);

    let changed_file = {
        let mut docs = sh.docs.lock().unwrap();
        let d = docs.get_mut(&target)?;
        let changed = d.path.as_deref() != Some(abs.as_path());
        d.path = Some(abs.clone());
        d.enc = dec.enc;
        d.bom = dec.bom;
        d.eol = eol;
        d.mtime = meta.modified().ok();
        d.dirty = false;
        changed
    };
    update_title(app, &target);

    crate::trace::mark(&format!("file-read {target}"));
    let payload = DocPayload {
        path: abs.to_string_lossy().into_owned(),
        name: file_name(&abs),
        dir: abs
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: meta.len(),
        content: dec.text,
        encoding: dec.enc.name(),
        reload: reload && !changed_file,
        announce: false,
    };
    let announce = {
        let mut docs = sh.docs.lock().unwrap();
        match docs.get_mut(&target) {
            Some(d) => {
                d.emitted = true;
                // 미리보기를 걷거나 창을 보이려고 첫 화면을 기다리는 중인가
                !reload && (d.preview.is_some() || d.show_pending)
            }
            None => false,
        }
    };
    let payload = DocPayload {
        announce,
        ..payload
    };
    let _ = app.emit_to(target.as_str(), "document", payload);
    crate::trace::mark(&format!("document-emitted {target}"));

    if changed_file {
        watch(app, &target, &abs);
    }
    if !reload {
        sh.settings.lock().unwrap().remember_recent(&abs);
        save_settings(app);
    }
    crate::menu::refresh(app);
    Some(target)
}

/// 열기 대화상자. 첫 파일은 지금 창에, 나머지는 새 창에.
pub fn open_dialog(app: &AppHandle, label: Option<&str>) {
    let exts: Vec<&str> = DOC_EXTENSIONS.to_vec();
    let mut dlg = app
        .dialog()
        .file()
        .add_filter("Markdown", &exts)
        .add_filter("*", &["*"]);
    if let Some(win) = label.and_then(|l| app.get_webview_window(l)) {
        dlg = dlg.set_parent(&win);
    }
    let Some(files) = dlg.blocking_pick_files() else {
        return;
    };
    for (i, f) in files.into_iter().enumerate() {
        if let Ok(p) = f.into_path() {
            open_file(app, if i == 0 { label } else { None }, &p, false, false);
        }
    }
}

// ── 저장 ─────────────────────────────────────────────────────────────────

/// 저장하지 않은 편집이 있을 때 묻는다 — 저장 · 저장 안 함 · 취소.
/// 저장을 고르면 렌더러에 저장을 시키고, **끝난 뒤에** then 을 한다(save_document 의 after_save).
/// 저장이 실패하거나 사용자가 취소하면 then 은 일어나지 않고 창은 그대로 남는다.
pub fn ask_save_then(app: &AppHandle, label: &str, then: After) {
    let sh = shared(app);
    let tr = sh.tr;
    let name = sh
        .docs
        .lock()
        .unwrap()
        .get(label)
        .and_then(|d| d.path.as_deref().map(file_name))
        .unwrap_or_default();
    let mut dlg = app
        .dialog()
        .message(format!("{}\n\n{}", tr.dlg_save_title, name))
        .title("Marklet")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            tr.dlg_save.into(),
            tr.dlg_dont_save.into(),
            tr.dlg_cancel.into(),
        ));
    if let Some(win) = app.get_webview_window(label) {
        dlg = dlg.parent(&win);
    }
    match dlg.blocking_show_with_result() {
        MessageDialogResult::Custom(s) if s == tr.dlg_save => {
            if let Some(d) = sh.docs.lock().unwrap().get_mut(label) {
                d.after_save = Some(then);
            }
            send_command(app, label, "save");
        }
        MessageDialogResult::Custom(s) if s == tr.dlg_dont_save => {
            if let Some(d) = sh.docs.lock().unwrap().get_mut(label) {
                d.dirty = false;
            }
            update_title(app, label);
            run_after(app, label, then);
        }
        // 취소: 끝내려던 것도 멈춘다.
        _ => sh.quitting.store(false, Ordering::SeqCst),
    }
}

fn run_after(app: &AppHandle, label: &str, then: After) {
    match then {
        After::Close => {
            if let Some(d) = shared(app).docs.lock().unwrap().get_mut(label) {
                d.force_close = true;
            }
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.close();
            }
        }
        After::Open(p) => {
            open_file(app, Some(label), &p, false, true);
        }
    }
}

/// 파일에 쓴다.
///
/// ★ 열 때의 인코딩 · BOM · 줄바꿈 그대로 되돌려 쓴다. 한 글자도 안 고쳤는데 파일이 통째로 달라지면 안 된다.
/// ★ 임시 파일에 쓰고 이름을 바꿔 덮어쓴다. 쓰다가 멈춰도 원본은 온전하다.
/// ★ 열 때 이후 다른 곳에서 파일이 바뀌었으면 덮어쓰기 전에 묻는다.
/// 블로킹이다(대화상자). 메인 스레드에서 부르지 마라.
pub fn save_document(app: &AppHandle, label: &str, content: &str) -> bool {
    let sh = shared(app);
    let tr = sh.tr;
    let (abs, enc, bom, eol, mtime) = {
        let docs = sh.docs.lock().unwrap();
        match docs
            .get(label)
            .and_then(|d| d.path.clone().map(|p| (p, d.enc, d.bom, d.eol, d.mtime)))
        {
            Some(t) => t,
            None => return false,
        }
    };
    let name = file_name(&abs);
    let win = app.get_webview_window(label);

    // 열 때 이후 다른 곳에서 바뀌었는가 (파일이 사라졌으면 새로 만든다)
    if let Ok(m) = std::fs::metadata(&abs).and_then(|m| m.modified()) {
        if mtime.is_some() && Some(m) != mtime {
            let mut dlg = app
                .dialog()
                .message(format!(
                    "{}\n\n{}\n{}",
                    tr.dlg_conflict_title, name, tr.dlg_conflict_body
                ))
                .title("Marklet")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    tr.dlg_overwrite.into(),
                    tr.dlg_cancel.into(),
                ));
            if let Some(w) = &win {
                dlg = dlg.parent(w);
            }
            if !dlg.blocking_show() {
                return false;
            }
        }
    }

    let text = apply_eol(content, eol);
    let (mut enc, mut bom) = (enc, bom);
    let buf = match encode_text(&text, enc, bom) {
        Some(b) => b,
        None => {
            // 이 인코딩(EUC-KR)으로 표현 못 하는 글자가 들어왔다(이모지 등). 몰래 깨뜨리지 않고 묻는다.
            let mut dlg = app
                .dialog()
                .message(format!(
                    "{}\n\n{}",
                    tr.dlg_encoding_title, tr.dlg_encoding_body
                ))
                .title("Marklet")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    tr.dlg_save_utf8.into(),
                    tr.dlg_cancel.into(),
                ));
            if let Some(w) = &win {
                dlg = dlg.parent(w);
            }
            if !dlg.blocking_show() {
                return false;
            }
            enc = Enc::Utf8;
            bom = false;
            match encode_text(&text, enc, bom) {
                Some(b) => b,
                None => return false,
            }
        }
    };

    let tmp = {
        let mut s = abs.clone().into_os_string();
        s.push(".marklet-tmp");
        PathBuf::from(s)
    };
    let written = std::fs::write(&tmp, &buf).and_then(|_| std::fs::rename(&tmp, &abs));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        error_box(app, format!("{name}\n\n{e}"));
        return false;
    }

    // 우리가 쓴 것이 감시에 다시 걸려 '다른 곳에서 바뀜' 으로 오인되지 않게 시각을 기억한다.
    let after = {
        let mut docs = sh.docs.lock().unwrap();
        match docs.get_mut(label) {
            Some(d) => {
                d.mtime = std::fs::metadata(&abs).and_then(|m| m.modified()).ok();
                d.dirty = false;
                d.enc = enc;
                d.bom = bom;
                d.after_save.take()
            }
            None => None,
        }
    };
    update_title(app, label);
    if let Some(a) = after {
        run_after(app, label, a);
    }
    true
}

// ── 감시 ─────────────────────────────────────────────────────────────────

/// 다른 편집기에서 저장하면 따라 바뀐다.
/// ★ 파일이 아니라 **폴더**를 지켜본다. 많은 편집기가 임시 파일에 쓰고 이름을 바꿔 저장하므로
///   파일 하나에 건 감시는 첫 저장 뒤에 조용히 끊긴다.
pub fn watch(app: &AppHandle, label: &str, abs: &Path) {
    let sh = shared(app);
    let Some(dir) = abs.parent().map(Path::to_path_buf) else {
        return;
    };
    let name = abs.file_name().map(|n| n.to_os_string());
    let (app2, label2, abs2) = (app.clone(), label.to_string(), abs.to_path_buf());

    let deb = new_debouncer(
        Duration::from_millis(150),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if !events
                .iter()
                .any(|e| e.path.file_name().map(|n| n.to_os_string()) == name)
            {
                return;
            }
            on_file_changed(&app2, &label2, &abs2);
        },
    );
    let Ok(mut deb) = deb else { return };
    // 감시를 못 붙여도 문서는 열린다. 그냥 자동 갱신만 없다.
    if deb
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .is_err()
    {
        return;
    }
    let mut docs = sh.docs.lock().unwrap();
    if let Some(d) = docs.get_mut(label) {
        d.watcher = Some(deb);
    }
}

fn on_file_changed(app: &AppHandle, label: &str, abs: &Path) {
    let sh = shared(app);
    {
        let docs = sh.docs.lock().unwrap();
        let Some(d) = docs.get(label) else { return };
        if d.path.as_deref() != Some(abs) {
            return;
        }
        // ★ 편집 중이면 갱신하지 않는다. 쓰던 글 위에 디스크 내용을 덮어씌우면 안 된다.
        //   저장할 때 save_document 가 '다른 곳에서 바뀜' 을 물어본다.
        if d.dirty {
            return;
        }
        // 우리가 방금 쓴 것이면 무시한다.
        match std::fs::metadata(abs).and_then(|m| m.modified()) {
            Ok(m) if Some(m) == d.mtime => return,
            Err(_) => return,
            _ => {}
        }
    }
    open_file(app, Some(label), abs, true, false);
}
