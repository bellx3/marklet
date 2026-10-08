//! 네이티브 뷰어 창과 앱의 접점. 읽기만 하는 문서는 WebView2 없이 `preview` 의 창이 끝까지 보여 준다 — 그 창들의 수명을 여기서 다룬다.
//!
//! · 문서를 열 때 먼저 창(뷰어 또는 미리보기)을 띄우고, 창이 문서를 읽어 **모양을 정하면**(`Handle::wait_mode`) 뷰어는 그대로 두고
//!   미리보기면 WebView2 창을 만들어 이어 붙인다(`open_new`).
//! · 뷰어에서 편집 · 인쇄 · PDF 를 누르거나 문서에 수식 · Mermaid 가 있으면 같은 창을 미리보기로 바꿔 WebView2 창에 넘긴다(`upgrade`).
//! · 뷰어가 닫히면 이 앱의 창 목록에서 빼고, 창이 하나도 없으면 앱을 끝낸다(`closed`).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::app::{
    error_box, file_name, is_doc_path, open_external, open_file, save_settings, shared, watch, Doc,
};
use crate::links::resolve_doc_link;
use crate::preview::bar::MenuState;
use crate::preview::{self, Cmd, Handle, Hooks, Mode};
use crate::state::Bounds;
use crate::strings::{self, Strings};
use crate::text::{decode_text, has_ext};

/// 창 스레드가 앱을 부를 때 쓴다. 첫 창은 Tauri 보다 먼저 뜨므로 setup 에서 채운다(그 전의 부름은 무시한다).
pub static APP: OnceLock<AppHandle> = OnceLock::new();

static INITIAL_HOOKS: Mutex<Option<Arc<NativeHooks>>> = Mutex::new(None);

fn locale_strings() -> &'static Strings {
    static S: OnceLock<&'static Strings> = OnceLock::new();
    S.get_or_init(|| strings::pick(&sys_locale::get_locale().unwrap_or_default()))
}

/// 창이 앱에 알리는 일(`preview::Hooks`)을 앱 쪽 함수로 잇는다. 창마다 하나 — 어느 문서의 창인지 라벨을 든다.
pub struct NativeHooks {
    label: Mutex<String>,
}

impl NativeHooks {
    pub fn new(label: &str) -> Arc<NativeHooks> {
        Arc::new(NativeHooks {
            label: Mutex::new(label.to_string()),
        })
    }

    pub fn set_label(&self, l: &str) {
        *self.label.lock().unwrap() = l.to_string();
    }

    fn label(&self) -> String {
        self.label.lock().unwrap().clone()
    }
}

/// 프로세스가 켜지자마자 뜨는 첫 창의 훅(라벨은 앱이 문서를 이어받을 때 정한다)
pub fn initial_hooks() -> Arc<dyn Hooks> {
    let h = NativeHooks::new("");
    *INITIAL_HOOKS.lock().unwrap() = Some(h.clone());
    h
}

impl Hooks for NativeHooks {
    fn closed(&self, bounds: Option<Bounds>) {
        match APP.get() {
            Some(app) => closed(app, &self.label(), bounds),
            // 앱이 아직 준비되기 전에 첫 창을 닫았다 — 닫는다는 것은 끝내겠다는 뜻이다
            None => std::process::exit(0),
        }
    }

    fn open_link(&self, href: &str) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let (label, href) = (self.label(), href.to_string());
        std::thread::spawn(move || {
            let dir = shared(&app).docs.lock().unwrap().get(&label).and_then(|d| {
                d.path
                    .as_ref()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            });
            // ★ 네트워크 경로(//host · \\host)가 되는 링크는 여기서 걸러진다 — 열기만 해도 SMB 인증이 나간다(links.rs).
            if let Some(path) = dir.and_then(|d| resolve_doc_link(&d, &href)) {
                open_file(&app, Some(&label), &path, false, false);
            }
        });
    }

    fn open_external(&self, url: &str) {
        open_external(url);
    }

    fn upgrade(&self, command: Option<&str>) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let (label, command) = (self.label(), command.map(str::to_string));
        std::thread::spawn(move || upgrade(&app, &label, command));
    }

    fn zoom(&self, dir: i32) {
        if let Some(app) = APP.get() {
            crate::cmd::step_zoom(app, dir.signum());
        }
    }

    fn action(&self, name: &str) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let (label, name) = (self.label(), name.to_string());
        // 대화상자가 뜰 수 있다 — 창 스레드를 붙잡지 않는다
        std::thread::spawn(move || crate::menu::run_action(&app, &label, &name));
    }

    fn dropped(&self, path: PathBuf) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let label = self.label();
        if is_doc_path(&path) {
            std::thread::spawn(move || {
                open_file(&app, Some(&label), &path, false, false);
            });
        }
    }

    fn strings(&self) -> &'static Strings {
        match APP.get() {
            Some(app) => shared(app).tr,
            None => locale_strings(),
        }
    }

    fn menu_state(&self) -> MenuState {
        let Some(app) = APP.get() else {
            return MenuState {
                theme: "system".into(),
                remote_images: false,
                native_view: true,
                keep_warm: true,
                autostart: false,
                recent: Vec::new(),
            };
        };
        let s = shared(app).settings.lock().unwrap().clone();
        MenuState {
            theme: s.theme,
            remote_images: s.remote_images,
            native_view: s.native_view,
            keep_warm: s.keep_warm,
            autostart: crate::autostart::is_enabled(),
            recent: s
                .recent
                .iter()
                .map(|p| {
                    Path::new(p)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.clone())
                })
                .collect(),
        }
    }

    fn theme_setting(&self) -> String {
        APP.get()
            .map(|a| shared(a).settings.lock().unwrap().theme.clone())
            .unwrap_or_else(|| "system".into())
    }
}

pub fn korean(app: &AppHandle) -> bool {
    std::ptr::eq(shared(app).tr, &strings::KO)
}

// ── 창 목록 ────────────────────────────────────────────────────────────────

pub fn handle_of(app: &AppHandle, label: &str) -> Option<Handle> {
    shared(app)
        .docs
        .lock()
        .unwrap()
        .get(label)
        .and_then(|d| d.native.clone())
}

pub fn has_native(app: &AppHandle) -> bool {
    shared(app)
        .docs
        .lock()
        .unwrap()
        .values()
        .any(|d| d.native.is_some())
}

/// 네이티브 창 전부에 일을 시킨다
pub fn each(app: &AppHandle, mut f: impl FnMut(&Handle)) {
    let handles: Vec<Handle> = shared(app)
        .docs
        .lock()
        .unwrap()
        .values()
        .filter_map(|d| d.native.clone())
        .collect();
    for h in &handles {
        f(h);
    }
}

/// 떠 있는 창 아무거나 앞으로 가져온다(문서 없이 또 켰을 때). 가져왔으면 true.
pub fn focus_any(app: &AppHandle) -> bool {
    if let Some(w) = app.webview_windows().values().next() {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return true;
    }
    let mut any = false;
    each(app, |h| {
        if !any {
            h.post(Cmd::Focus);
            any = true;
        }
    });
    any
}

/// 이 문서(원문)를 이 설정 · 환경에서 네이티브 뷰어가 끝까지 맡을 수 있는가 — 앱이 먼저 가려 두고, 창은 읽고 나서 한 번 더 가린다.
pub fn viewer_ok(app: &AppHandle, path: &Path, text: &str, len: usize) -> bool {
    let sh = shared(app);
    let (native, remote) = {
        let s = sh.settings.lock().unwrap();
        (s.native_view, s.remote_images)
    };
    if !preview::native_wanted(native, len) {
        return false;
    }
    if has_ext(path, &["txt"]) {
        return true;
    }
    let f = preview::md::parse(text).features;
    !(f.needs_web() || (f.remote_images && remote))
}

// ── 열기 ───────────────────────────────────────────────────────────────────

/// 새 창에 문서를 연다. 창(뷰어 또는 미리보기)을 먼저 띄우고, 창이 모양을 정하면 뷰어는 그대로 두고 미리보기면 WebView2 창을 이어 붙인다.
/// 블로킹이다(창이 문서를 읽을 때까지 잠깐 기다린다). 열었으면 창의 라벨.
pub fn open_new(app: &AppHandle, abs: &Path) -> Option<String> {
    let sh = shared(app);
    let n = sh.counter.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("w{n}");
    let offset = sh.docs.lock().unwrap().len() as f64 * 28.0;
    let opts = {
        let s = sh.settings.lock().unwrap();
        preview::Opts::from_settings(&s, offset, korean(app))
    };
    // 진짜 창(웹)이 뜨기 전에 사용자가 이 창을 닫으면 그 웹 창을 닫는다(웹 창의 라벨은 나중에 정해진다)
    let web_label: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let on_close: Arc<dyn Fn() + Send + Sync> = {
        let (app2, slot) = (app.clone(), web_label.clone());
        Arc::new(move || {
            let l = slot.lock().unwrap().clone();
            if let Some(w) = l.and_then(|l| app2.get_webview_window(&l)) {
                let _ = w.close();
            }
        })
    };
    let hooks = NativeHooks::new(&label);
    let is_initial = preview::peek_initial(abs);
    let handle = preview::open(abs, opts, on_close, hooks.clone());
    let Some(handle) = handle else {
        // 창 없이 웹 창으로(미리볼 수 없는 문서 · 미리보기를 끈 실행)
        return crate::app::open_web(app, abs, None, None, Some(web_label));
    };
    // 첫 창이면 라벨을 이어받은 훅에 알려 준다
    if is_initial {
        if let Some(h) = INITIAL_HOOKS.lock().unwrap().take() {
            h.set_label(&label);
        }
    }
    match handle.wait_mode(Duration::from_millis(600)) {
        Mode::Viewer => {
            register(app, &label, abs, handle);
            Some(label)
        }
        _ => crate::app::open_web(app, abs, Some(handle), None, Some(web_label)),
    }
}

/// 뷰어 창을 이 앱의 창 목록에 올린다
fn register(app: &AppHandle, label: &str, abs: &Path, handle: Handle) {
    let sh = shared(app);
    let mtime = std::fs::metadata(abs).and_then(|m| m.modified()).ok();
    {
        let mut docs = sh.docs.lock().unwrap();
        let mut d = Doc::new(Some(abs.to_path_buf()), None);
        d.native = Some(handle);
        d.path = Some(abs.to_path_buf());
        d.mtime = mtime;
        d.ready = true;
        d.show_pending = false;
        docs.insert(label.to_string(), d);
    }
    watch(app, label, abs);
    sh.settings.lock().unwrap().remember_recent(abs);
    save_settings(app);
    crate::menu::refresh(app);
    crate::trace::mark(&format!("native-registered {label}"));
}

/// 이미 떠 있는 뷰어 창에 문서를 띄운다(링크 · 다시 읽기 · 최근 문서 · 끌어다 놓기). 문서에 못 그리는 것이 있으면 WebView2 로 넘긴다.
pub fn reopen(
    app: &AppHandle,
    label: &str,
    handle: &Handle,
    abs: &Path,
    reload: bool,
) -> Option<String> {
    let sh = shared(app);
    let meta = match std::fs::metadata(abs) {
        Ok(m) => m,
        Err(e) => {
            error_box(app, format!("{}\n\n{e}", file_name(abs)));
            return None;
        }
    };
    if meta.len() > crate::app::MAX_BYTES {
        error_box(app, format!("{}: file is too large.", file_name(abs)));
        return None;
    }
    let bytes = match std::fs::read(abs) {
        Ok(b) => b,
        Err(e) => {
            error_box(app, format!("{}\n\n{e}", file_name(abs)));
            return None;
        }
    };
    let text = decode_text(&bytes).text;
    let plain = has_ext(abs, &["txt"]);
    let keep_scroll = {
        let mut docs = sh.docs.lock().unwrap();
        let d = docs.get_mut(label)?;
        let same = d.path.as_deref() == Some(abs);
        d.path = Some(abs.to_path_buf());
        d.mtime = meta.modified().ok();
        // 다른 파일로 갈아탔으면 감시도 옮긴다
        if !same {
            d.watcher = None;
        }
        reload && same
    };
    if sh
        .docs
        .lock()
        .unwrap()
        .get(label)
        .map(|d| d.watcher.is_none())
        .unwrap_or(false)
    {
        watch(app, label, abs);
    }
    let ok = viewer_ok(app, abs, &text, bytes.len());
    handle.post(Cmd::SetDoc {
        src: Arc::new(text),
        path: Some(abs.to_path_buf()),
        title: file_name(abs),
        plain,
        keep_scroll,
    });
    if !reload {
        sh.settings.lock().unwrap().remember_recent(abs);
        save_settings(app);
    }
    crate::menu::refresh(app);
    if !ok {
        upgrade(app, label, None);
    }
    Some(label.to_string())
}

// ── 업그레이드: 뷰어 → WebView2 ─────────────────────────────────────────────────

/// 뷰어로는 못 하는 일(편집 · 인쇄 · PDF · 수식 · Mermaid)이 필요하다 — 같은 창을 미리보기로 바꾸고 WebView2 창을 만들어 이어 붙인다.
/// 웹 창이 문서를 그리면 미리보기가 걷히며 바뀐다(처음 켤 때와 같은 길). command 는 그린 뒤 바로 할 일.
pub fn upgrade(app: &AppHandle, label: &str, command: Option<String>) {
    let sh = shared(app);
    let (handle, path) = {
        let mut docs = sh.docs.lock().unwrap();
        let Some(d) = docs.get(label) else { return };
        let (Some(h), Some(p)) = (d.native.clone(), d.path.clone()) else {
            return;
        };
        docs.remove(label);
        (h, p)
    };
    let web_label: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let on_close: Arc<dyn Fn() + Send + Sync> = {
        let (app2, slot) = (app.clone(), web_label.clone());
        Arc::new(move || {
            let l = slot.lock().unwrap().clone();
            if let Some(w) = l.and_then(|l| app2.get_webview_window(&l)) {
                let _ = w.close();
            }
        })
    };
    handle.post(Cmd::ToPreview(on_close));
    crate::trace::mark(&format!("native-upgrade {label}"));
    if crate::app::open_web(app, &path, Some(handle.clone()), command, Some(web_label)).is_none() {
        // 웹 창을 못 만들었다 — 이 창을 다시 뷰어로 돌려놓지는 못하니 그대로 닫는다(사용자는 문서를 다시 열면 된다)
        handle.post(Cmd::Close);
    }
}

// ── 닫기 ───────────────────────────────────────────────────────────────────

/// 뷰어 창이 닫혔다. 창 목록에서 빼고(감시도 끝난다) 마지막 창이면 앱을 끝낸다.
pub fn closed(app: &AppHandle, label: &str, bounds: Option<Bounds>) {
    let sh = shared(app);
    if let Some(b) = bounds {
        sh.settings.lock().unwrap().bounds = Some(b);
        save_settings(app);
    }
    sh.docs.lock().unwrap().remove(label);
    {
        let mut f = sh.focused.lock().unwrap();
        if f.as_deref() == Some(label) {
            *f = None;
        }
    }
    crate::menu::refresh(app);
    maybe_exit(app);
}

/// 창이 하나도 없으면 앱을 끝낸다. 숨겨 둔 웹 창이 기다리는 중이면 그 대기 시간이 끝낼 것이고, 로그인 때 미리 켠 앱은 끝내지 않는다.
pub fn maybe_exit(app: &AppHandle) {
    let sh = shared(app);
    if !sh.docs.lock().unwrap().is_empty() {
        return;
    }
    if sh.warm.lock().unwrap().is_some() && !sh.quitting.load(Ordering::SeqCst) {
        return;
    }
    if sh.resident.load(Ordering::SeqCst) && !sh.quitting.load(Ordering::SeqCst) {
        return;
    }
    // 웹 창이 아직 떠 있으면(숨겨 둔 것 포함) Tauri 가 알아서 한다
    if app.webview_windows().is_empty() || sh.quitting.load(Ordering::SeqCst) {
        app.exit(0);
    }
}
