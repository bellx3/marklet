//! 네이티브 뷰어 — Win32 + Direct2D + DirectWrite 로 마크다운을 직접 그린다.
//!
//! 두 가지로 쓰인다.
//!   · **미리보기(Preview)** — WebView2 는 창 하나를 띄우는 데 0.1~0.4초가 걸린다(처음 켤 때는 브라우저 프로세스부터 올려야 해서 0.4초,
//!     이미 떠 있는 앱에서 둘째 창은 0.1초). 그동안 같은 문서를 먼저 그려 둔다. WebView2 가 첫 화면을 올리면(`app::finish_swap`) 같은 자리에서 진짜 렌더로 바뀐다.
//!   · **뷰어(Viewer)** — 읽기만 하는 문서는 WebView2 를 아예 만들지 않고 이 창이 끝까지 보여 준다. 글자 고르기 · 복사 · 링크 · 찾기 · 목차 ·
//!     확대 · 원문 보기가 여기 있다. 편집 · 인쇄 · 수식 · Mermaid 가 필요하면(`Hooks::upgrade`) WebView2 창으로 넘긴다.
//!
//! 창마다 하나씩 있다. 첫 문서의 것은 프로세스가 켜지자마자(Tauri 보다 먼저) 띄우고(`start_initial`),
//! 앱이 떠 있는 동안 여는 문서의 것은 문서를 열 때 띄운다(`open`).
//!
//! 구성: md(마크다운 → 블록) · layout(블록 → 그릴 것) · hl(코드 색) · img(그림) · view(상태) · select · find · paint · window(Win32)

#[cfg(windows)]
pub mod bar;
#[cfg(windows)]
pub mod darkbar;
pub mod find;
pub mod hl;
pub mod img;
pub mod layout;
pub mod md;
#[cfg(windows)]
pub mod paint;
#[cfg(windows)]
pub mod select;
#[cfg(windows)]
pub mod view;
#[cfg(windows)]
pub mod window;

#[cfg(windows)]
pub use window::{system_dark as window_system_dark, Cmd, Handle, Hooks, Mode};

/// 윈도 밖에는 네이티브 뷰어가 없다. Doc 이 같은 모양을 쓰도록 빈 껍데기만 둔다.
#[cfg(not(windows))]
#[derive(Clone)]
pub struct Handle;

#[cfg(not(windows))]
impl Handle {
    pub fn scroll_y(&self) -> f32 {
        0.0
    }
    pub fn close_requested(&self) -> bool {
        false
    }
    pub fn close(&self) {}
}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use super::window::{self, Handle, Hooks, Params};
    use crate::state::{state_file, Settings};
    use crate::text::{decode_text, has_ext};

    /// 프로세스가 켜지자마자 띄운 첫 창(어느 문서의 것인지와 함께). 첫 창이 이어받는다.
    static INITIAL: Mutex<Option<(PathBuf, Handle)>> = Mutex::new(None);

    /// Tauri 설정의 identifier 와 같아야 한다(설정 폴더 이름이다).
    const IDENTIFIER: &str = "com.marklet.md.desktop";
    /// 미리보기에 쓰는 원문의 상한. 첫 몇 화면이면 충분하다.
    const MAX_CHARS: usize = 200_000;
    /// 이보다 큰 문서는 렌더러도 서식 없이 보여 준다(main.ts PLAIN_LIMIT).
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    /// 네이티브 뷰어가 끝까지 맡는 문서의 크기 상한. 더 크면 WebView2 가 덩어리로 나눠 그린다(여기는 문서 전체를 메모리에 놓는다).
    pub const NATIVE_MAX_BYTES: usize = 800 * 1024;

    /// 창이 따를 모양(설정에서 온다)
    pub struct Opts {
        pub dark: bool,
        pub zoom: f64,
        /// 논리 px: (너비, 높이, x, y)
        pub bounds: Option<(f64, f64, Option<f64>, Option<f64>)>,
        pub remote_images: bool,
        /// 읽기만 하는 문서는 이 창이 끝까지 보여 줄 수 있는가(설정)
        pub native: bool,
        pub korean: bool,
    }

    impl Opts {
        pub fn from_settings(s: &Settings, offset: f64, korean: bool) -> Opts {
            Opts {
                dark: is_dark(&s.theme),
                zoom: s.zoom,
                // 창을 여럿 열면 겹치지 않게 조금씩 비껴 놓는다(진짜 창과 같은 값).
                bounds: s.bounds.map(|b| {
                    (
                        b.width,
                        b.height,
                        b.x.map(|x| x + offset),
                        b.y.map(|y| y + offset),
                    )
                }),
                remote_images: s.remote_images,
                native: s.native_view,
                korean,
            }
        }
    }

    fn is_dark(theme: &str) -> bool {
        match theme {
            "dark" => true,
            "light" => false,
            _ => window::system_dark(),
        }
    }

    /// 환경변수로 끄는 길(비교 · 문제 확인용): `MARKLET_NATIVE=0`
    fn env_allows_native() -> bool {
        std::env::var("MARKLET_NATIVE")
            .map(|v| v != "0")
            .unwrap_or(true)
    }

    /// 네이티브 뷰어를 쓰는 설정인가(설정과 환경변수)
    pub fn native_on(setting: bool) -> bool {
        setting && env_allows_native()
    }

    /// 이 문서(len 바이트)는 네이티브 뷰어가 끝까지 맡아도 되는가. 문서 안에 못 그리는 것이 있는지는 따로 가린다(`md::Features`).
    /// 스크린 리더가 켜져 있으면 쓰지 않는다 — 네이티브로 그린 글은 읽어 줄 수 없다(접근성 트리가 없다).
    pub fn native_wanted(setting: bool, len: usize) -> bool {
        native_on(setting) && len <= NATIVE_MAX_BYTES && !window::screen_reader_active()
    }

    fn native_allowed(opts: &Opts, len: usize) -> bool {
        native_wanted(opts.native, len)
    }

    /// 이미 떠 있는 앱이 있는가. 있으면 이 프로세스는 곧 그쪽으로 인자를 넘기고 끝나므로 창을 띄우면 안 된다.
    /// (단일 인스턴스 플러그인이 `<identifier>-sim` 이름의 뮤텍스를 쓴다. 우리는 만들지 않고 열어 보기만 한다.)
    pub fn another_instance_running() -> bool {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
        let name: Vec<u16> = format!("{IDENTIFIER}-sim")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) {
                Ok(h) => {
                    let _ = CloseHandle(h);
                    true
                }
                Err(_) => false,
            }
        }
    }

    /// 보여 줄 문서의 원문. (원문, 끝까지 맡을 수 있는 크기인가, .txt 인가). 못 보여 주는 문서면 None.
    ///   · 마크다운은 늘 미리보기가 된다(첫 화면). 큰 것은 첫 20만 자까지만 읽는다.
    ///   · .txt 는 네이티브 뷰어가 맡을 때만 보여 준다(WebView2 로는 미리볼 것이 없다).
    fn read_source(path: &Path, opts: &Opts) -> Option<(String, bool, bool)> {
        let md = has_ext(path, &["md", "markdown", "mdown", "mkd"]);
        let txt = has_ext(path, &["txt"]);
        if !md && !txt {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() > MAX_BYTES {
            return None;
        }
        let full = native_allowed(opts, bytes.len());
        if txt && !full {
            return None;
        }
        let mut src = decode_text(&bytes).text;
        if !full && src.chars().count() > MAX_CHARS {
            let cut = src
                .char_indices()
                .nth(MAX_CHARS)
                .map(|(i, _)| i)
                .unwrap_or(src.len());
            src.truncate(cut);
            if let Some(nl) = src.rfind('\n') {
                src.truncate(nl);
            }
        }
        Some((src, full, txt))
    }

    fn spawn_for(
        path: &Path,
        o: Opts,
        on_close: Option<Arc<dyn Fn() + Send + Sync>>,
        hooks: Option<Arc<dyn Hooks>>,
    ) -> Option<Handle> {
        // 끄는 길(비교 · 문제 확인용): MARKLET_NO_PREVIEW=1
        if std::env::var_os("MARKLET_NO_PREVIEW").is_some() {
            return None;
        }
        let (src, native_ok, plain) = read_source(path, &o)?;
        Some(window::spawn(Params {
            title: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: Some(path.to_path_buf()),
            src,
            native_ok,
            plain,
            dark: o.dark,
            zoom: o.zoom,
            bounds: o.bounds,
            remote_images: o.remote_images,
            korean: o.korean,
            on_event: crate::trace::mark,
            on_close,
            hooks,
            dry_run: false,
        }))
    }

    /// 창 없이 한 번 그려 본다. 로그인 때 미리 켠 앱이 쉬는 동안 Direct2D · DirectWrite · 글꼴을 프로세스에 올려 두면
    /// 첫 문서가 40ms 쯤 빨리 뜬다(77/111 → 48/48 ms, 이미 한 번 띄워 본 앱과 같아진다).
    pub fn prewarm() {
        let _ = window::spawn(Params {
            title: String::new(),
            path: None,
            src: "# Marklet\n\n본문 한 줄입니다. **굵게** `코드`\n".to_string(),
            native_ok: false,
            plain: false,
            dark: false,
            zoom: 1.0,
            bounds: None,
            remote_images: false,
            korean: true,
            on_event: |_| {},
            on_close: None,
            hooks: None,
            dry_run: true,
        });
    }

    /// 프로세스가 켜지자마자(Tauri 보다 먼저) 첫 문서의 창을 띄운다. 설정은 직접 읽는다.
    /// 이미 떠 있는 앱이 있으면 아무것도 하지 않는다 — 이 프로세스는 문서를 그쪽에 넘기고 곧 끝난다.
    pub fn start_initial(files: &[PathBuf], hooks: Arc<dyn Hooks>) {
        let Some(first) = files.first() else {
            return;
        };
        if another_instance_running() {
            return;
        }
        let over = crate::state::data_dir_override();
        let data_dir = over
            .clone()
            .or_else(|| std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(IDENTIFIER)));
        let electron = if over.is_some() {
            None
        } else {
            std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("marklet").join("state.json"))
        };
        let settings = match &data_dir {
            Some(d) => Settings::load(&state_file(d), electron.as_deref()),
            None => Settings::default(),
        };
        let korean = sys_locale::get_locale()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .starts_with("ko");
        // 첫 창: 사용자가 이 미리보기를 닫으면 앱을 끝낸다(on_close 없음).
        if let Some(h) = spawn_for(
            first,
            Opts::from_settings(&settings, 0.0, korean),
            None,
            Some(hooks),
        ) {
            *INITIAL.lock().unwrap() = Some((first.clone(), h));
        }
    }

    /// 이 창(path 를 열러 만든 창)의 뷰어/미리보기. 첫 창이면 `start_initial` 이 띄워 둔 것을, 아니면 지금 띄운다.
    /// on_close: 진짜 창이 뜨기 전에 사용자가 미리보기를 닫았을 때 그 문서의 창을 닫는 일.
    pub fn open(
        path: &Path,
        opts: Opts,
        on_close: Arc<dyn Fn() + Send + Sync>,
        hooks: Arc<dyn Hooks>,
    ) -> Option<Handle> {
        {
            let mut g = INITIAL.lock().unwrap();
            if g.as_ref().map(|(p, _)| p == path).unwrap_or(false) {
                return g.take().map(|(_, h)| h);
            }
        }
        spawn_for(path, opts, Some(on_close), Some(hooks))
    }

    /// 첫 창이 이 문서의 것이면 꺼내 준다(창이 아직 모양을 못 정했을 수 있다 — 기다리는 것은 부르는 쪽이 한다).
    pub fn peek_initial(path: &Path) -> bool {
        INITIAL
            .lock()
            .unwrap()
            .as_ref()
            .map(|(p, _)| p == path)
            .unwrap_or(false)
    }
}

#[cfg(windows)]
pub use imp::{
    another_instance_running, native_on, native_wanted, open, peek_initial, prewarm, start_initial,
    Opts,
};

#[cfg(not(windows))]
pub fn another_instance_running() -> bool {
    false
}
