//! 네이티브 뷰어 창 — Win32 + Direct2D(소프트웨어) + DirectWrite.
//!
//! 두 가지 모양으로 쓰인다.
//!   · **Preview** — WebView2 가 켜지는 동안(≈0.4초) 같은 문서의 첫 화면을 먼저 그려 둔다. 진짜 창이 첫 프레임을 올리면 걷힌다.
//!   · **Viewer** — 문서를 네이티브로 끝까지 읽는다. WebView2 를 아예 만들지 않는다(읽기만 하는 문서의 대부분). 글자 고르기 · 복사 · 링크 ·
//!     찾기 · 목차 · 확대 · 원문 보기를 여기서 한다. 편집 · 인쇄 · 수식 · Mermaid 가 필요해지면 `Hooks::upgrade` 로 WebView2 창에 넘긴다.
//!
//! ★ 별도 스레드에서 돈다(자기 메시지 루프). 메인 스레드는 그동안 Tauri 를 띄운다 — 서로를 기다리지 않는다.
//! ★ Direct2D 렌더 타깃은 **소프트웨어**로 만든다. 기본(하드웨어 가능)은 D3D 장치를 만드느라 165ms 가 걸렸고
//!   소프트웨어는 26ms 였다(실측). 글 몇 화면 그리는 데 GPU 가 필요 없다.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use windows::core::{w, Interface, BOOL, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_USE_IMMERSIVE_DARK_MODE,
};
use windows::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, GetMonitorInfoW, InvalidateRect, MonitorFromRect,
    MonitorFromWindow, SetBkColor, SetTextColor, ValidateRect, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_QUALITY, FF_DONTCARE, FW_NORMAL, HBRUSH, HDC, HFONT, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL, OUT_DEFAULT_PRECIS,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{DragAcceptFiles, DragFinish, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::bar::{Bar, MenuState};
use super::darkbar;
use super::layout::{palette, Brushes, Ctx, Gfx, COLS};
use super::md::{self, Doc};
use super::menu::{self, Act, At, Popup};
use super::view::{Pos, Selection, Ui, View, DOCK_W};
use crate::state::Bounds;
use crate::strings::Strings;

// ── 공개 모양 ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 아직 문서를 읽는 중이다
    Undecided,
    /// WebView2 가 뜨는 동안만 있는 창
    Preview,
    /// 문서를 끝까지 이 창이 보여 준다
    Viewer,
}

/// 다른 스레드에서 창에 시키는 일
pub enum Cmd {
    /// 같은 창에 다른 문서(또는 다시 읽은 같은 문서)를 띄운다
    SetDoc {
        src: Arc<String>,
        path: Option<PathBuf>,
        title: String,
        plain: bool,
        keep_scroll: bool,
    },
    Theme(bool),
    Zoom(f32),
    Focus,
    /// 창을 닫는다(뷰어)
    Close,
    /// Preview 로 바꾸고, 사용자가 닫으면 이 일을 한다 — 뷰어를 WebView2 창으로 넘길 때
    ToPreview(Arc<dyn Fn() + Send + Sync>),
    /// 설정이 바뀌었다(원격 그림 정책 · 언어)
    Settings {
        remote_images: bool,
    },
    Image(PathBuf, Option<super::img::Decoded>),
}

/// 메인 스레드가 부르는 창 조작.
#[derive(Clone)]
pub struct Handle {
    hwnd: Arc<AtomicIsize>,
    /// 진짜 창이 이미 이어받았다. 미리보기 창이 아직 안 떴으면 이제는 뜨지 않는다(뒤늦게 떠서 진짜 창을 덮는 일이 없게).
    cancelled: Arc<AtomicBool>,
    /// 지금 읽는 자리(CSS px, f32 비트). 진짜 창이 이어받을 때 그 자리로 간다.
    scroll: Arc<AtomicU32>,
    /// 사용자가 진짜 창이 뜨기 전에 미리보기를 닫았다(= 이 문서를 닫겠다는 뜻). 진짜 창은 뜨는 대로 닫는다.
    close_requested: Arc<AtomicBool>,
    mode: Arc<(Mutex<Mode>, Condvar)>,
    cmds: Arc<Mutex<VecDeque<Cmd>>>,
}

pub struct Geometry {
    /// 바깥 창의 왼쪽 위(화면 좌표, 물리 px)
    pub x: i32,
    pub y: i32,
    /// 클라이언트 영역 크기(물리 px)
    pub w: u32,
    pub h: u32,
}

const WM_SWAP_CLOSE: u32 = WM_APP + 1;
const WM_CMDS: u32 = WM_APP + 2;
/// 찾기 입력칸이 받은 키를 부모에게 넘긴다(wParam = 가상 키, lParam = 1 이면 Shift)
const WM_FIND_KEY: u32 = WM_APP + 3;
const LAYOUT_TIMER: usize = 1;
const SCROLL_TIMER: usize = 2;
const AUTOSCROLL_TIMER: usize = 3;
const FIND_TIMER: usize = 4;
const CTL_HIDE_TIMER: usize = 5;
const CTL_TAP_TIMER: usize = 6;
const TIP_TIMER: usize = 7;
const ID_EDIT: isize = 101;
/// 그림을 동시에 읽는 최대 수
const MAX_IMAGE_LOADS: usize = 3;
/// 창 스레드와 문서 준비 스레드의 스택. 깊이 중첩된 인용 · 목록을 재귀로 풀어도 넘치지 않게 넉넉히 잡는다(쓰는 만큼만 실제 메모리다).
const THREAD_STACK: usize = 64 * 1024 * 1024;
// 입력칸(EDIT) 메시지(windows 크레이트의 기능 조합에 없어 직접 적는다)
const WM_MOUSELEAVE: u32 = 0x02a3;
const EM_SETSEL: u32 = 0x00b1;
const EM_SETMARGINS: u32 = 0x00d3;
const EM_SETCUEBANNER: u32 = 0x1501;

impl Handle {
    fn new() -> Handle {
        Handle {
            hwnd: Arc::new(AtomicIsize::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
            scroll: Arc::new(AtomicU32::new(0)),
            close_requested: Arc::new(AtomicBool::new(false)),
            mode: Arc::new((Mutex::new(Mode::Undecided), Condvar::new())),
            cmds: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    fn hwnd(&self) -> Option<HWND> {
        let v = self.hwnd.load(Ordering::SeqCst);
        if v == 0 {
            None
        } else {
            Some(HWND(v as *mut _))
        }
    }

    pub fn close_requested(&self) -> bool {
        self.close_requested.load(Ordering::SeqCst)
    }

    /// 미리보기에서 읽던 자리(CSS px)
    pub fn scroll_y(&self) -> f32 {
        f32::from_bits(self.scroll.load(Ordering::SeqCst))
    }

    pub fn mode(&self) -> Mode {
        *self.mode.0.lock().unwrap()
    }

    fn set_mode(&self, m: Mode) {
        *self.mode.0.lock().unwrap() = m;
        self.mode.1.notify_all();
    }

    /// 창이 문서를 읽고 모양(Preview · Viewer)을 정할 때까지 기다린다(최대 timeout). 못 정했으면 Undecided.
    pub fn wait_mode(&self, timeout: Duration) -> Mode {
        let g = self.mode.0.lock().unwrap();
        let (g, _) = self
            .mode
            .1
            .wait_timeout_while(g, timeout, |m| *m == Mode::Undecided)
            .unwrap();
        *g
    }

    /// 창에 일을 시킨다(비동기).
    pub fn post(&self, cmd: Cmd) {
        self.cmds.lock().unwrap().push_back(cmd);
        if let Some(h) = self.hwnd() {
            unsafe {
                let _ = PostMessageW(Some(h), WM_CMDS, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn geometry(&self) -> Option<Geometry> {
        let h = self.hwnd()?;
        unsafe {
            let (mut outer, mut client) = (RECT::default(), RECT::default());
            GetWindowRect(h, &mut outer).ok()?;
            GetClientRect(h, &mut client).ok()?;
            Some(Geometry {
                x: outer.left,
                y: outer.top,
                w: (client.right - client.left).max(0) as u32,
                h: (client.bottom - client.top).max(0) as u32,
            })
        }
    }

    /// 진짜 창(hwnd)을 미리보기 **바로 뒤**에 보인다 — 같은 자리라 완전히 가려진다. 활성화하지 않는다.
    /// ★ 이렇게 미리 보여 두면 WebView2 가 가려진 채로 그리고 있다가, 미리보기를 걷는 순간 이미 그려진 화면이 드러난다.
    ///   숨겨 둔 창을 그때 `show()` 하면 첫 프레임이 나오기까지 50~70ms 를 더 기다리고, 그동안 빈 화면이 비칠 수 있다.
    pub fn show_behind(&self, real: isize) -> bool {
        let Some(p) = self.hwnd() else { return false };
        unsafe {
            let real = HWND(real as *mut _);
            // 열릴 때의 페이드 인이 미리보기를 걷는 순간까지 이어지면 진짜 창이 반투명한 채로 드러난다 — 미리 꺼 둔다.
            let on = BOOL(1);
            let _ = DwmSetWindowAttribute(
                real,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &on as *const _ as *const _,
                std::mem::size_of::<BOOL>() as u32,
            );
            SetWindowPos(
                real,
                Some(p),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .is_ok()
        }
    }

    /// 진짜 창이 뜬 뒤 미리보기를 걷는다.
    pub fn close(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(h) = self.hwnd() {
            unsafe {
                let _ = PostMessageW(Some(h), WM_SWAP_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

/// 창이 앱에 알리거나 부탁하는 일. 앱(app.rs)이 채운다.
pub trait Hooks: Send + Sync {
    /// 뷰어 창이 닫혔다. bounds 는 닫기 직전의 모양(논리 px) — 최대화 · 전체 화면이면 None.
    fn closed(&self, bounds: Option<Bounds>);
    /// 문서의 상대 링크를 눌렀다
    fn open_link(&self, href: &str);
    fn open_external(&self, url: &str);
    /// 이 창으로는 못 하는 일(편집 · 인쇄 · PDF)이 필요하다 — WebView2 창으로 넘긴다. command 는 넘긴 뒤 바로 할 일(`edit` · `print` · `pdf`).
    fn upgrade(&self, command: Option<&str>);
    fn zoom(&self, dir: i32);
    /// 메뉴 · 단축키가 부른 일(`open` · `close` · `quit` · `theme:dark` …). 앱이 알아서 한다.
    fn action(&self, name: &str);
    /// 문서 파일을 끌어다 놓았다
    fn dropped(&self, path: PathBuf);
    /// 이 창의 사정(최근 문서 · 체크 표시 · 글)
    fn strings(&self) -> &'static Strings;
    /// 메뉴 막대가 그릴 현재 상태(체크 표시 · 최근 문서)
    fn menu_state(&self) -> MenuState;
    /// 설정의 테마(system · light · dark) — 시스템 테마가 바뀌면 따라가야 하는지 가린다
    fn theme_setting(&self) -> String;
}

pub struct Params {
    pub title: String,
    pub path: Option<PathBuf>,
    pub src: String,
    /// 앱이 네이티브로 끝까지 보여 주기를 허락했는가(설정 · 문서 크기 · 접근성 · 환경). 허락해도 문서에 못 그리는 것이 있으면 Preview 로 간다.
    pub native_ok: bool,
    /// .txt — 서식 없이 원문으로 보여 주는 것이 기본이다
    pub plain: bool,
    pub dark: bool,
    pub zoom: f64,
    /// 논리 px: (너비, 높이, x, y)
    pub bounds: Option<(f64, f64, Option<f64>, Option<f64>)>,
    pub remote_images: bool,
    pub korean: bool,
    /// 첫 그림이 끝난 직후 불린다(시각 기록용)
    pub on_event: fn(&str),
    /// 사용자가 진짜 창이 뜨기 전에 미리보기를 닫았을 때 부른다(그 문서의 창을 닫는 일). None 이면 앱을 끝낸다 —
    /// 프로세스가 켜지자마자 띄우는 첫 미리보기(첫 창)가 그렇다.
    pub on_close: Option<Arc<dyn Fn() + Send + Sync>>,
    pub hooks: Option<Arc<dyn Hooks>>,
    /// 한 번 그려 보고 창을 보이지 않은 채 없앤다 — Direct2D · DirectWrite 를 프로세스에 미리 올려 두려는 것이다(`preview::prewarm`).
    pub dry_run: bool,
}

// ── 창 상태 ────────────────────────────────────────────────────────────────

/// 끌고 있는 것
enum Drag {
    None,
    Select,
    Thumb { grab: f32 },
}

struct State {
    hwnd: HWND,
    rt: ID2D1HwndRenderTarget,
    view: View,
    mode: Mode,
    hooks: Option<Arc<dyn Hooks>>,
    handle: Handle,
    swapped: bool,
    on_close: Option<Arc<dyn Fn() + Send + Sync>>,
    strings: &'static Strings,

    // 입력
    drag: Drag,
    moved: bool,
    press_link: Option<Arc<str>>,
    last_click: (Instant, i32, i32, u32),
    cursor: Cursor,
    leave_tracked: bool,
    mouse: (i32, i32),

    // 찾기 입력칸
    edit: HWND,
    edit_font: HFONT,
    edit_brush: HBRUSH,
    find_dirty: bool,

    fullscreen: Option<(isize, RECT)>,
    /// 읽기를 기다리는 그림과 지금 읽고 있는 수
    img_queue: VecDeque<Arc<PathBuf>>,
    img_active: usize,
    /// 메뉴 막대(Alt). 평소에는 숨겨 둔다.
    bar: Option<Bar>,
    bar_visible: bool,
    /// Alt 만 눌렀다 뗐는가(다른 키 없이) — 메뉴 막대를 보이거나 숨긴다
    alt_alone: bool,
    /// 마지막으로 컨트롤을 띄운 마우스 자리(조금 움직인 것은 움직임으로 치지 않는다)
    ctl_last: (i32, i32),
    /// 메뉴를 열기 전에 초점이 있던 자식 창(찾기 칸). 메뉴를 닫으면 돌려준다.
    menu_prev_focus: HWND,
    /// 더 보기(⋮)로 연 메뉴: 컨트롤을 메뉴가 닫힐 때까지 붙들어 두었다. 값은 그전에 컨트롤이 고정돼 있었는가.
    menu_ctl: Option<bool>,
    /// 마지막으로 알려 준 읽는 자리(진짜 창이 이어받는다)
    scroll_out: Arc<AtomicU32>,
    slot: Arc<AtomicIsize>,
    close_requested: Arc<AtomicBool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cursor {
    Arrow,
    IBeam,
    Hand,
}

// 찾기 입력칸을 감싼 창 프로시저의 원래 것(시스템 EDIT). 모든 창이 같은 것이다.
static EDIT_OLD: AtomicIsize = AtomicIsize::new(0);

fn lo(lp: LPARAM) -> i32 {
    (lp.0 & 0xffff) as i16 as i32
}
fn hi(lp: LPARAM) -> i32 {
    ((lp.0 >> 16) & 0xffff) as i16 as i32
}
fn key_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { GetKeyState(vk.0 as i32) < 0 }
}

fn clipboard_set(owner: HWND, text: &str) {
    unsafe {
        if OpenClipboard(Some(owner)).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        if let Ok(h) = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2) {
            let p = GlobalLock(h) as *mut u16;
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
                let _ = GlobalUnlock(h);
                // CF_UNICODETEXT = 13
                let _ = SetClipboardData(13, Some(HANDLE(h.0)));
            }
        }
        let _ = CloseClipboard();
    }
}

impl State {
    fn invalidate(&self) {
        unsafe {
            let _ = InvalidateRect(Some(self.hwnd), None, false);
        }
    }

    /// 다시 놓은 뒤(크기 · 확대 · 목차 · 원문 보기) 첫 화면 밖의 나머지를 틈틈이 이어 놓는 타이머를 건다. 다 놓았으면 걸지 않는다.
    fn kick_layout(&self) {
        if !self.view.is_done() {
            unsafe {
                SetTimer(Some(self.hwnd), LAYOUT_TIMER, 10, None);
            }
        }
    }

    fn is_viewer(&self) -> bool {
        self.mode == Mode::Viewer
    }

    /// 읽는 자리를 메인 스레드에 알리는 곳에 적는다
    fn publish_scroll(&self) {
        self.scroll_out
            .store(self.view.scroll.to_bits(), Ordering::SeqCst);
    }

    fn after_scroll(&mut self) {
        self.view.ensure();
        self.view.clamp();
        self.kick_layout();
        self.publish_scroll();
        if self.view.dock_open {
            self.view.follow_active_in_dock();
        }
        self.invalidate();
    }

    fn start_scroll_timer(&self) {
        unsafe {
            SetTimer(Some(self.hwnd), SCROLL_TIMER, 15, None);
        }
    }

    /// 부드럽게 dy(CSS px) 만큼
    fn scroll_by(&mut self, dy: f32) {
        self.view.scroll_by(dy);
        if self.view.animating() {
            self.start_scroll_timer();
        }
        self.after_scroll();
    }

    fn scroll_to(&mut self, y: f32, animate: bool) {
        self.view.scroll_to(y, animate);
        if self.view.animating() {
            self.start_scroll_timer();
        }
        self.after_scroll();
    }

    // ── 크기 · 배율 ────────────────────────────────────────────────────────

    fn on_size(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        // 열린 메뉴는 크기가 바뀌면 닫힌다(자리가 창 안으로 눌려 정해진 것이라 어긋난다)
        self.close_menu();
        unsafe {
            let _ = self.rt.Resize(&D2D_SIZE_U {
                width: w,
                height: h,
            });
        }
        self.view.cw = w;
        self.view.ch = h;
        self.view.reflow();
        self.view.clamp();
        self.kick_layout();
        self.layout_find_edit();
        self.invalidate();
    }

    /// 확대(배율)가 바뀌었다
    fn set_zoom(&mut self, zoom: f32) {
        if (self.view.zoom - zoom).abs() < 1e-4 {
            return;
        }
        self.close_menu();
        // 보던 블록은 relayout 이 지켜 준다
        self.view.zoom = zoom;
        self.view.relayout();
        self.view.ensure();
        self.view.clamp();
        self.kick_layout();
        self.publish_scroll();
        self.layout_find_edit();
        self.update_edit_font();
        self.invalidate();
    }

    fn set_theme(&mut self, dark: bool) {
        self.view.set_dark(dark);
        set_menu_mode(dark);
        unsafe {
            let v = BOOL(dark as i32);
            let _ = DwmSetWindowAttribute(
                self.hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &v as *const _ as *const _,
                std::mem::size_of::<BOOL>() as u32,
            );
            if !self.edit_brush.is_invalid() {
                let _ = DeleteObject(self.edit_brush.into());
            }
            let p = palette(dark)[super::layout::Col::CodeInline as usize];
            self.edit_brush = CreateSolidBrush(colorref(p));
            if !self.edit.is_invalid() {
                let _ = InvalidateRect(Some(self.edit), None, true);
            }
        }
        self.invalidate();
    }

    fn set_doc(
        &mut self,
        src: Arc<String>,
        path: Option<PathBuf>,
        title: String,
        plain: bool,
        keep_scroll: bool,
    ) {
        self.close_menu();
        let keep = if keep_scroll { self.view.scroll } else { 0.0 };
        let dock = self.view.dock_open;
        self.view.src = src.clone();
        self.view.plain_view = plain;
        self.view.ctx.dir = path
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));
        self.view.ctx.fm_open = false;
        self.view.images.clear();
        self.view.sel = None;
        self.view.find.clear();
        self.view.doc = if plain {
            md::parse_plain(&src)
        } else {
            md::parse(&src)
        };
        self.view.scroll = 0.0;
        self.view.scroll_target = 0.0;
        self.view.dock_open = dock;
        self.view.dock_scroll = 0.0;
        self.view.relayout();
        self.view.scroll = keep;
        self.view.scroll_target = keep;
        self.view.ensure();
        self.view.clamp();
        self.publish_scroll();
        if self.view.find_open && !self.view.find.query.is_empty() {
            let q = self.view.find.query.clone();
            self.view.run_find(&q);
        }
        unsafe {
            let t: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            let _ = SetWindowTextW(self.hwnd, PCWSTR(t.as_ptr()));
            if self.view.is_done() {
                let _ = KillTimer(Some(self.hwnd), LAYOUT_TIMER);
            } else {
                SetTimer(Some(self.hwnd), LAYOUT_TIMER, 10, None);
            }
        }
        self.invalidate();
    }

    fn run_cmds(&mut self) {
        loop {
            let c = self.handle.cmds.lock().unwrap().pop_front();
            let Some(c) = c else { break };
            match c {
                Cmd::SetDoc {
                    src,
                    path,
                    title,
                    plain,
                    keep_scroll,
                } => self.set_doc(src, path, title, plain, keep_scroll),
                Cmd::Theme(d) => self.set_theme(d),
                Cmd::Zoom(z) => self.set_zoom(z),
                Cmd::Focus => unsafe {
                    if IsIconic(self.hwnd).as_bool() {
                        let _ = ShowWindow(self.hwnd, SW_RESTORE);
                    }
                    let _ = SetForegroundWindow(self.hwnd);
                },
                Cmd::Close => unsafe {
                    let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                },
                Cmd::ToPreview(on_close) => {
                    self.mode = Mode::Preview;
                    self.handle.set_mode(Mode::Preview);
                    self.on_close = Some(on_close);
                    self.close_menu();
                    self.close_find();
                }
                Cmd::Settings { remote_images } => {
                    if self.view.ctx.remote_images != remote_images {
                        self.view.ctx.remote_images = remote_images;
                        let keep = self.view.scroll;
                        self.view.relayout();
                        self.view.scroll = keep;
                        self.view.ensure();
                        self.view.clamp();
                        self.invalidate();
                    }
                }
                Cmd::Image(path, decoded) => self.image_ready(path, decoded),
            }
        }
    }

    // ── 그림 ───────────────────────────────────────────────────────────────

    /// 그리다가 필요하다고 본 그림을 스레드에서 읽는다. 동시에 몇 장만 읽는다 — 그림이 수백 장인 문서가 스레드 수백 개를 띄우면 안 된다.
    fn start_image_loads(&mut self) {
        let wanted: Vec<_> = std::mem::take(&mut self.view.want_images);
        self.img_queue.extend(wanted);
        while self.img_active < MAX_IMAGE_LOADS {
            let Some(p) = self.img_queue.pop_front() else {
                break;
            };
            let handle = self.handle.clone();
            let path = (*p).clone();
            // 화면 너비의 두 배(고해상도)를 넘는 그림은 줄여서 읽는다
            let max_w = (self.view.col_w * self.view.scale() * 2.0).max(256.0) as u32;
            let spawned = std::thread::Builder::new()
                .name("preview-img".into())
                .spawn(move || {
                    let d = super::img::decode(&path, max_w);
                    handle.post(Cmd::Image(path, d));
                });
            if spawned.is_ok() {
                self.img_active += 1;
            }
        }
    }

    fn image_ready(&mut self, path: PathBuf, decoded: Option<super::img::Decoded>) {
        use super::view::ImgSlot;
        self.img_active = self.img_active.saturating_sub(1);
        self.start_image_loads();
        let slot = match decoded {
            Some(d) => unsafe {
                let props = D2D1_BITMAP_PROPERTIES {
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                };
                match self.rt.CreateBitmap(
                    D2D_SIZE_U {
                        width: d.w,
                        height: d.h,
                    },
                    Some(d.bgra.as_ptr() as *const _),
                    d.w * 4,
                    &props,
                ) {
                    Ok(b) => ImgSlot::Ready(b),
                    Err(_) => ImgSlot::Failed,
                }
            },
            None => ImgSlot::Failed,
        };
        self.view.images.insert(path, slot);
        self.invalidate();
    }

    // ── 찾기 ───────────────────────────────────────────────────────────────

    fn edit_text(&self) -> String {
        unsafe {
            let n = GetWindowTextLengthW(self.edit).max(0) as usize;
            let mut buf = vec![0u16; n + 1];
            let got = GetWindowTextW(self.edit, &mut buf).max(0) as usize;
            String::from_utf16_lossy(&buf[..got])
        }
    }

    fn update_edit_font(&mut self) {
        unsafe {
            if !self.edit_font.is_invalid() {
                let _ = DeleteObject(self.edit_font.into());
            }
            let px = (15.0 * self.view.scale()).round() as i32;
            self.edit_font = CreateFontW(
                -px,
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                DEFAULT_QUALITY,
                FF_DONTCARE.0 as u32,
                w!("Segoe UI"),
            );
            if !self.edit.is_invalid() {
                SendMessageW(
                    self.edit,
                    WM_SETFONT,
                    Some(WPARAM(self.edit_font.0 as usize)),
                    Some(LPARAM(1)),
                );
                let pad = (12.0 * self.view.scale()) as isize;
                SendMessageW(
                    self.edit,
                    EM_SETMARGINS,
                    Some(WPARAM((EC_LEFTMARGIN | EC_RIGHTMARGIN) as usize)),
                    Some(LPARAM(pad | (pad << 16))),
                );
            }
        }
    }

    /// 찾기 입력칸을 알약 안에 놓는다
    fn layout_find_edit(&mut self) {
        if self.edit.is_invalid() || !self.view.find_open {
            return;
        }
        let g = self.view.find_geo();
        let s = self.view.scale();
        let line = (15.0 * 1.45 * s).round() as i32;
        let (l, t, r, b) = (g.pill[0] * s, g.pill[1] * s, g.pill[2] * s, g.pill[3] * s);
        let h = line.min((b - t) as i32);
        unsafe {
            let _ = SetWindowPos(
                self.edit,
                None,
                (l + 8.0 * s) as i32,
                (t + ((b - t) - h as f32) / 2.0) as i32,
                (r - l - 16.0 * s) as i32,
                h,
                SWP_NOZORDER | SWP_SHOWWINDOW,
            );
        }
    }

    fn open_find(&mut self) {
        if self.view.dock_open && false {
            return;
        }
        if self.edit.is_invalid() {
            unsafe {
                let hinst = GetModuleHandleW(None).unwrap_or_default();
                let edit = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("EDIT"),
                    w!(""),
                    WS_CHILD | WS_VISIBLE | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                    0,
                    0,
                    10,
                    10,
                    Some(self.hwnd),
                    Some(HMENU(ID_EDIT as *mut _)),
                    Some(hinst.into()),
                    None,
                );
                if let Ok(e) = edit {
                    self.edit = e;
                    let old = SetWindowLongPtrW(
                        e,
                        GWLP_WNDPROC,
                        edit_proc as *const () as usize as isize,
                    );
                    EDIT_OLD.store(old, Ordering::SeqCst);
                    // 안내 글(placeholder)
                    let hint: Vec<u16> = (if self.view.ctx.korean {
                        "문서에서 찾기"
                    } else {
                        "Find in document"
                    })
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                    SendMessageW(
                        e,
                        EM_SETCUEBANNER,
                        Some(WPARAM(1)),
                        Some(LPARAM(hint.as_ptr() as isize)),
                    );
                }
            }
            self.update_edit_font();
        }
        self.view.find_open = true;
        self.view.find.clear();
        self.view.find.query.clear();
        unsafe {
            if !self.edit.is_invalid() {
                let _ = SetWindowTextW(self.edit, w!(""));
                let _ = ShowWindow(self.edit, SW_SHOW);
                let _ = SetFocus(Some(self.edit));
            }
        }
        self.layout_find_edit();
        self.invalidate();
    }

    fn close_find(&mut self) {
        if !self.view.find_open {
            return;
        }
        self.view.find_open = false;
        self.view.find.clear();
        self.view.ui_hover = None;
        unsafe {
            let _ = KillTimer(Some(self.hwnd), FIND_TIMER);
            if !self.edit.is_invalid() {
                let _ = ShowWindow(self.edit, SW_HIDE);
            }
            let _ = SetFocus(Some(self.hwnd));
        }
        self.find_dirty = false;
        self.invalidate();
    }

    fn run_find_now(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.hwnd), FIND_TIMER);
        }
        self.find_dirty = false;
        let q = self.edit_text();
        self.view.run_find(&q);
        self.finish_find_scroll();
    }

    fn finish_find_scroll(&mut self) {
        if self.view.animating() {
            self.start_scroll_timer();
        }
        self.after_scroll();
    }

    fn find_step(&mut self, dir: i32) {
        if self.find_dirty {
            self.run_find_now();
        }
        self.view.find.step(dir);
        self.view.scroll_to_current_match();
        self.finish_find_scroll();
    }

    // ── 목차 ───────────────────────────────────────────────────────────────

    fn toggle_dock(&mut self) {
        if !self.view.dock_open && !self.view.has_headings() {
            return;
        }
        self.view.dock_open = !self.view.dock_open;
        self.view.dock_hover = None;
        self.view.reflow();
        self.view.follow_active_in_dock();
        self.kick_layout();
        self.layout_find_edit();
        self.invalidate();
    }

    // ── 입력 ───────────────────────────────────────────────────────────────

    fn copy_selection(&mut self) {
        let t = self.view.selected_text();
        if !t.is_empty() {
            clipboard_set(self.hwnd, &t);
        }
    }

    fn activate_link(&mut self, href: &str) {
        if let Some(id) = href.strip_prefix('#') {
            if self.view.jump_to_anchor(id) {
                if self.view.animating() {
                    self.start_scroll_timer();
                }
                self.after_scroll();
            }
            return;
        }
        let lower = href.to_ascii_lowercase();
        if ["http:", "https:", "mailto:", "tel:"]
            .iter()
            .any(|p| lower.starts_with(p))
        {
            if let Some(h) = &self.hooks {
                h.open_external(href);
            }
            return;
        }
        if let Some(h) = &self.hooks {
            h.open_link(href);
        }
    }

    fn click_count(&mut self, x: i32, y: i32) -> u32 {
        let now = Instant::now();
        let (t, lx, ly, n) = self.last_click;
        let dt = Duration::from_millis(unsafe { GetDoubleClickTime() } as u64);
        let (dx, dy) = (
            unsafe { GetSystemMetrics(SM_CXDOUBLECLK) } / 2,
            unsafe { GetSystemMetrics(SM_CYDOUBLECLK) } / 2,
        );
        let count = if now.duration_since(t) <= dt && (x - lx).abs() <= dx && (y - ly).abs() <= dy {
            (n % 3) + 1
        } else {
            1
        };
        self.last_click = (now, x, y, count);
        count
    }

    fn on_button_down(&mut self, x: i32, y: i32) {
        unsafe {
            let _ = SetFocus(Some(self.hwnd));
        }
        let (fx, fy) = (x as f32, y as f32);
        // 화면 장치(막대 · 도크 · 스크롤바)가 먼저 받는다
        if let Some(ui) = self.view.ui_hit(fx, fy) {
            self.on_ui_down(ui, fx, fy);
            return;
        }
        // 앞머리를 눌러 펴고 접는다
        if self.view.hot_at(fx, fy).is_some() {
            self.view.toggle_front_matter();
            self.kick_layout();
            self.invalidate();
            return;
        }
        let count = self.click_count(x, y);
        self.alt_alone = false;
        if count > 1 {
            // 더블클릭(낱말 고르기)의 첫 클릭이 컨트롤 토글로 오인되지 않게 기다리던 것을 취소한다
            unsafe {
                let _ = KillTimer(Some(self.hwnd), CTL_TAP_TIMER);
            }
        }
        self.moved = false;
        self.press_link = None;
        // 그림을 눌렀고 그 그림이 링크이면 눌렀다 뗄 때 간다
        if let Some(href) = self.view.image_href_at(fx, fy) {
            self.press_link = Some(href);
            self.view.sel = None;
            self.drag = Drag::Select;
            unsafe {
                SetCapture(self.hwnd);
            }
            self.invalidate();
            return;
        }
        let hit = self.view.hit_test(fx, fy);
        match hit {
            Some(h) if count == 2 => {
                self.view.select_word_at(h.pos);
                self.drag = Drag::None;
            }
            Some(h) if count >= 3 => {
                self.view.select_text_at(h.pos);
                self.drag = Drag::None;
            }
            Some(h) => {
                if h.inside {
                    self.press_link = h.link.clone();
                }
                self.view.sel = Some(Selection {
                    anchor: h.pos,
                    focus: h.pos,
                });
                self.drag = Drag::Select;
                unsafe {
                    SetCapture(self.hwnd);
                }
            }
            None => {
                self.view.sel = None;
                self.drag = Drag::None;
            }
        }
        self.invalidate();
    }

    fn on_ui_down(&mut self, ui: Ui, x: f32, y: f32) {
        match ui {
            Ui::FindClose => self.close_find(),
            Ui::FindPrev => self.find_step(-1),
            Ui::FindNext => self.find_step(1),
            Ui::FindInput | Ui::FindBar => unsafe {
                if !self.edit.is_invalid() {
                    let _ = SetFocus(Some(self.edit));
                }
            },
            Ui::DockClose => self.toggle_dock(),
            Ui::DockItem(i) => {
                if let Some(it) = self.view.dock_items.get(i) {
                    let heading = it.heading;
                    self.view.jump_to_heading(heading);
                    if self.view.animating() {
                        self.start_scroll_timer();
                    }
                    self.after_scroll();
                }
            }
            Ui::DockArea | Ui::CtlBar => {}
            Ui::Ctl(i) => self.on_ctl_click(i),
            Ui::Thumb => {
                let s = self.view.scale();
                if let Some(t) = self.view.thumb_rect() {
                    self.drag = Drag::Thumb {
                        grab: y / s * 1.0 - t[1],
                    };
                    unsafe {
                        SetCapture(self.hwnd);
                    }
                }
                let _ = x;
            }
            Ui::Track => {
                // 손잡이 위/아래를 누르면 한 쪽씩
                let s = self.view.scale();
                if let Some(t) = self.view.thumb_rect() {
                    let page = self.view.view_h() * 0.875;
                    let dy = if y / s < t[1] { -page } else { page };
                    self.scroll_by(dy);
                }
            }
        }
        self.invalidate();
    }

    fn on_mouse_move(&mut self, x: i32, y: i32) {
        self.mouse = (x, y);
        // 메뉴가 열려 있으면 메뉴가 먼저 받는다(컨트롤 · 툴팁 · 커서는 그동안 가만히 둔다)
        if self.menu_move(x, y) {
            return;
        }
        let (fx, fy) = (x as f32, y as f32);
        let s = self.view.scale();
        match self.drag {
            Drag::Thumb { grab } => {
                let view = self.view.view_h();
                let total = self.view.layout.height;
                let thumb_h = (view * view / total).max(32.0);
                let track = view - thumb_h;
                if track > 0.0 {
                    let top = (fy / s - grab).clamp(0.0, track);
                    let target = top / track * (total - view);
                    self.view.scroll_to(target, false);
                    self.after_scroll();
                }
                return;
            }
            Drag::Select => {
                self.moved = true;
                if let Some(h) = self.view.hit_test(fx, fy) {
                    if let Some(sel) = &mut self.view.sel {
                        sel.focus = h.pos;
                    }
                }
                // 창 밖으로 끌면 그쪽으로 굴린다
                unsafe {
                    let ch = self.view.ch as i32;
                    if y < 0 || y > ch {
                        SetTimer(Some(self.hwnd), AUTOSCROLL_TIMER, 30, None);
                    } else {
                        let _ = KillTimer(Some(self.hwnd), AUTOSCROLL_TIMER);
                    }
                }
                self.invalidate();
                return;
            }
            Drag::None => {}
        }
        // 마우스를 올린 것
        let ui = self.view.ui_hit(fx, fy);
        // 떠오르는 컨트롤: 마우스를 조금이라도 움직이면 나타났다가 잠시 뒤 사라진다(스크롤이 만든 가짜 움직임은 거른다)
        let over_ctl = matches!(ui, Some(Ui::Ctl(_)) | Some(Ui::CtlBar));
        let moved_px = (x - self.ctl_last.0).abs() + (y - self.ctl_last.1).abs();
        if moved_px >= 3 {
            self.ctl_last = (x, y);
            if !self.view.ctl_pinned && self.ctl_ok() {
                self.show_controls(!over_ctl);
            }
        }
        if over_ctl {
            // 컨트롤 위에 있는 동안은 사라지지 않는다. 누르려는 순간에 사라지면 안 된다.
            unsafe {
                let _ = KillTimer(Some(self.hwnd), CTL_HIDE_TIMER);
            }
        }
        // 툴팁: 같은 단추에 잠깐 머물면 뜬다
        let hover_ctl = match ui {
            Some(Ui::Ctl(i)) => Some(i),
            _ => None,
        };
        let prev_ctl = match self.view.ui_hover {
            Some(Ui::Ctl(i)) => Some(i),
            _ => None,
        };
        if hover_ctl != prev_ctl {
            self.view.ctl_hover_since = hover_ctl.map(|_| Instant::now());
            unsafe {
                if hover_ctl.is_some() {
                    SetTimer(Some(self.hwnd), TIP_TIMER, 100, None);
                } else {
                    let _ = KillTimer(Some(self.hwnd), TIP_TIMER);
                }
            }
        }
        let hot_item = match ui {
            Some(Ui::DockItem(i)) => Some(i),
            _ => None,
        };
        let thumb = matches!(ui, Some(Ui::Thumb));
        let mut changed = false;
        if self.view.ui_hover != ui {
            self.view.ui_hover = ui;
            changed = true;
        }
        if self.view.dock_hover != hot_item {
            self.view.dock_hover = hot_item;
            changed = true;
        }
        if self.view.thumb_hot != thumb {
            self.view.thumb_hot = thumb;
            changed = true;
        }
        self.cursor = match ui {
            Some(
                Ui::FindPrev
                | Ui::FindNext
                | Ui::FindClose
                | Ui::DockClose
                | Ui::DockItem(_)
                | Ui::Ctl(_),
            ) => Cursor::Hand,
            Some(Ui::FindInput) => Cursor::IBeam,
            Some(_) => Cursor::Arrow,
            None => {
                if self.view.hot_at(fx, fy).is_some() || self.view.image_href_at(fx, fy).is_some() {
                    Cursor::Hand
                } else {
                    match self.view.hit_test(fx, fy) {
                        Some(h) if h.inside && h.link.is_some() => Cursor::Hand,
                        Some(h) if h.inside => Cursor::IBeam,
                        _ => Cursor::Arrow,
                    }
                }
            }
        };
        if changed {
            self.invalidate();
        }
        if !self.leave_tracked {
            self.leave_tracked = true;
            unsafe {
                let mut t = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: self.hwnd,
                    dwHoverTime: 0,
                };
                let _ = TrackMouseEvent(&mut t);
            }
        }
    }

    fn on_button_up(&mut self, x: i32, y: i32) {
        let was_thumb = matches!(self.drag, Drag::Thumb { .. });
        let was_select = matches!(self.drag, Drag::Select);
        self.drag = Drag::None;
        unsafe {
            let _ = ReleaseCapture();
            let _ = KillTimer(Some(self.hwnd), AUTOSCROLL_TIMER);
        }
        if was_thumb {
            return;
        }
        if !was_select {
            return;
        }
        // 끌지 않고 뗐다 = 클릭. 고른 것은 없다.
        if !self.moved {
            self.view.sel = None;
            let had_link = self.press_link.is_some();
            if let Some(link) = self.press_link.take() {
                let on_text = self
                    .view
                    .hit_test(x as f32, y as f32)
                    .map(|h| h.inside && h.link.as_deref() == Some(&*link))
                    .unwrap_or(false);
                let on_image =
                    self.view.image_href_at(x as f32, y as f32).as_deref() == Some(&*link);
                if on_text || on_image {
                    self.activate_link(&link);
                }
            }
            // 링크가 아닌 곳을 한 번 누르면 컨트롤이 열리고 닫힌다(사진 뷰어처럼). 더블클릭이면 취소된다.
            if !had_link && self.ctl_ok() && self.last_click.3 == 1 {
                unsafe {
                    SetTimer(Some(self.hwnd), CTL_TAP_TIMER, 250, None);
                }
            }
        }
        self.press_link = None;
        self.invalidate();
    }

    fn on_wheel(&mut self, delta: i32, x: i32, y: i32, horizontal: bool) {
        // 열린 메뉴는 휠을 굴리면 닫힌다(굴림은 문서가 그대로 받는다 — 웹 메뉴와 같다)
        self.close_menu();
        let ctrl = key_down(VK_CONTROL);
        let shift = key_down(VK_SHIFT);
        let (fx, fy) = (x as f32, y as f32);
        if ctrl && !horizontal {
            if let Some(h) = &self.hooks {
                h.zoom(if delta > 0 { 1 } else { -1 });
            }
            return;
        }
        // 목차 도크 위: 도크의 목록을 굴린다
        if self.view.dock_open && fx / self.view.scale() < DOCK_W {
            let lines = wheel_lines() as f32;
            self.view.dock_scroll -= delta as f32 / 120.0 * 100.0 * lines / 3.0;
            self.view.clamp_dock();
            self.invalidate();
            return;
        }
        let notches = delta as f32 / 120.0;
        // 코드 상자 위에서 가로 굴리기(Shift+휠 · 가로 휠)
        if (horizontal || shift)
            && self.scroll_code(fx, fy, if horizontal { notches } else { -notches })
        {
            return;
        }
        if horizontal {
            return;
        }
        let lines = wheel_lines() as f32;
        self.scroll_by(-notches * 100.0 * lines / 3.0);
    }

    /// 마우스 아래 코드 상자를 가로로 굴린다. 굴렸으면 true.
    fn scroll_code(&mut self, px: f32, py: f32, notches: f32) -> bool {
        use super::layout::Item;
        let s = self.view.scale();
        let (dx, dy) = (px / s - self.view.col_x, py / s + self.view.scroll);
        for it in &self.view.layout.items {
            if let Item::Text {
                y,
                h,
                clip: Some(c),
                meta: Some(m),
                ..
            } = it
            {
                if dy >= *y && dy < y + h && dx >= c[0] && dx < c[2] {
                    let max = (m.content_w - (c[2] - c[0])).max(0.0);
                    if max <= 0.0 {
                        return false;
                    }
                    let next = (m.hscroll.get() + notches * 60.0).clamp(0.0, max);
                    m.hscroll.set(next);
                    self.invalidate();
                    return true;
                }
            }
        }
        false
    }

    fn on_key(&mut self, vk: VIRTUAL_KEY) -> bool {
        let ctrl = key_down(VK_CONTROL);
        let shift = key_down(VK_SHIFT);
        let alt = key_down(VK_MENU);
        let page = (self.view.view_h() * 0.875).max(48.0);
        if ctrl && !alt {
            match vk {
                VK_C => {
                    self.copy_selection();
                    return true;
                }
                VK_A => {
                    self.view.select_all();
                    self.invalidate();
                    return true;
                }
                VK_F => {
                    if self.is_viewer() {
                        self.open_find();
                    }
                    return true;
                }
                VK_T => {
                    if self.is_viewer() {
                        self.toggle_dock();
                    }
                    return true;
                }
                VK_U => {
                    if self.is_viewer() {
                        let on = !self.view.plain_view;
                        self.view.set_plain_view(on);
                        self.after_scroll();
                    }
                    return true;
                }
                VK_E => {
                    self.upgrade(Some("edit"));
                    return true;
                }
                VK_P => {
                    self.upgrade(Some(if shift { "pdf" } else { "print" }));
                    return true;
                }
                VK_O => {
                    self.action("open");
                    return true;
                }
                VK_W => {
                    unsafe {
                        let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                    }
                    return true;
                }
                VK_Q => {
                    self.action("quit");
                    return true;
                }
                VK_OEM_PLUS | VK_ADD => {
                    if let Some(h) = &self.hooks {
                        h.zoom(1);
                    }
                    return true;
                }
                VK_OEM_MINUS | VK_SUBTRACT => {
                    if let Some(h) = &self.hooks {
                        h.zoom(-1);
                    }
                    return true;
                }
                VK_0 | VK_NUMPAD0 => {
                    if let Some(h) = &self.hooks {
                        h.zoom(0);
                    }
                    return true;
                }
                VK_HOME => {
                    self.scroll_to(0.0, false);
                    return true;
                }
                VK_END => {
                    self.scroll_to(1.0e9, false);
                    return true;
                }
                _ => return false,
            }
        }
        match vk {
            VK_F11 => {
                self.toggle_fullscreen();
                true
            }
            VK_F3 if self.view.find_open => {
                self.find_step(if shift { -1 } else { 1 });
                true
            }
            VK_ESCAPE => {
                if self.view.ctl_shown {
                    self.hide_controls();
                    true
                } else if self.view.find_open {
                    self.close_find();
                    true
                } else if self.fullscreen.is_some() {
                    self.toggle_fullscreen();
                    true
                } else {
                    false
                }
            }
            VK_DOWN => {
                self.scroll_by(40.0);
                true
            }
            VK_UP => {
                self.scroll_by(-40.0);
                true
            }
            VK_NEXT => {
                self.scroll_by(page);
                true
            }
            VK_PRIOR => {
                self.scroll_by(-page);
                true
            }
            VK_SPACE => {
                self.scroll_by(if shift { -page } else { page });
                true
            }
            VK_HOME => {
                self.scroll_to(0.0, false);
                true
            }
            VK_END => {
                self.scroll_to(1.0e9, false);
                true
            }
            _ => false,
        }
    }

    fn action(&mut self, name: &str) {
        if let Some(h) = &self.hooks {
            h.action(name);
        }
    }

    // ── 떠오르는 컨트롤 ──────────────────────────────────────────────────────

    /// 컨트롤을 띄울 수 있는 때인가(뷰어이고, 찾기 막대가 열려 있지 않다 — 그 위를 덮으면 안 된다)
    fn ctl_ok(&self) -> bool {
        self.is_viewer() && !self.view.find_open
    }

    fn show_controls(&mut self, auto_hide: bool) {
        if !self.ctl_ok() {
            return;
        }
        self.view.ctl_shown = true;
        unsafe {
            let _ = KillTimer(Some(self.hwnd), CTL_HIDE_TIMER);
            if auto_hide && !self.view.ctl_pinned {
                SetTimer(Some(self.hwnd), CTL_HIDE_TIMER, 2500, None);
            }
        }
        self.invalidate();
    }

    fn hide_controls(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.hwnd), CTL_HIDE_TIMER);
            let _ = KillTimer(Some(self.hwnd), CTL_TAP_TIMER);
            let _ = KillTimer(Some(self.hwnd), TIP_TIMER);
        }
        if self.view.ctl_shown || self.view.ctl_pinned {
            self.view.ctl_shown = false;
            self.view.ctl_pinned = false;
            if matches!(self.view.ui_hover, Some(Ui::Ctl(_)) | Some(Ui::CtlBar)) {
                self.view.ui_hover = None;
            }
            self.view.ctl_hover_since = None;
            self.invalidate();
        }
    }

    fn on_ctl_click(&mut self, i: u8) {
        match i {
            0 => {
                self.hide_controls();
                self.upgrade(Some("edit"));
            }
            1 => {
                self.hide_controls();
                self.toggle_dock();
            }
            2 => {
                self.hide_controls();
                self.open_find();
            }
            3 => {
                // 지금 어두우면 밝게, 아니면 어둡게
                let next = if self.view.dark {
                    "theme:light"
                } else {
                    "theme:dark"
                };
                self.action(next);
            }
            _ => {
                // 더 보기: 단추 아래에 우클릭과 같은 메뉴. 컨트롤은 메뉴가 닫힐 때까지 붙들어 둔다(웹 창과 같다).
                let (_, btns) = self.view.ctl_rects();
                let b = btns[4];
                if self.menu_ctl.is_none() {
                    self.menu_ctl = Some(self.view.ctl_pinned);
                }
                self.view.ctl_pinned = true;
                self.show_controls(false);
                self.open_menu(At::Below {
                    right: b[2],
                    bottom: b[3],
                });
            }
        }
    }

    // ── 메뉴 막대(Alt) ───────────────────────────────────────────────────────

    fn toggle_bar(&mut self) {
        if !self.is_viewer() {
            return;
        }
        unsafe {
            if self.bar_visible {
                let _ = SetMenu(self.hwnd, None);
                if let Some(b) = self.bar.take() {
                    b.destroy();
                }
                self.bar_visible = false;
            } else if let Some(h) = self.hooks.clone() {
                if let Some(b) = Bar::build(h.strings(), &h.menu_state()) {
                    let _ = SetMenu(self.hwnd, Some(b.hmenu));
                    self.bar = Some(b);
                    self.bar_visible = true;
                }
            }
            let _ = DrawMenuBar(self.hwnd);
        }
    }

    /// 메뉴 항목을 눌렀다. 창이 직접 하는 것은 여기서, 나머지는 앱에 넘긴다.
    fn run_menu_action(&mut self, name: &str) {
        match name {
            "find" => self.open_find(),
            "toc" => self.toggle_dock(),
            "source" => {
                let on = !self.view.plain_view;
                self.view.set_plain_view(on);
                self.after_scroll();
            }
            "edit" | "print" | "pdf" => self.upgrade(Some(name)),
            "zoom_in" => {
                if let Some(h) = &self.hooks {
                    h.zoom(1);
                }
            }
            "zoom_out" => {
                if let Some(h) = &self.hooks {
                    h.zoom(-1);
                }
            }
            "zoom_reset" => {
                if let Some(h) = &self.hooks {
                    h.zoom(0);
                }
            }
            "fullscreen" => self.toggle_fullscreen(),
            "close" => unsafe {
                let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            },
            other => self.action(other),
        }
    }

    fn upgrade(&mut self, command: Option<&str>) {
        if self.mode != Mode::Viewer {
            return;
        }
        if let Some(h) = &self.hooks {
            h.upgrade(command);
        }
    }

    // ── 전체 화면 ──────────────────────────────────────────────────────────

    fn toggle_fullscreen(&mut self) {
        unsafe {
            if let Some((style, rc)) = self.fullscreen.take() {
                SetWindowLongPtrW(self.hwnd, GWL_STYLE, style);
                let _ = SetWindowPos(
                    self.hwnd,
                    None,
                    rc.left,
                    rc.top,
                    rc.right - rc.left,
                    rc.bottom - rc.top,
                    SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            } else {
                let style = GetWindowLongPtrW(self.hwnd, GWL_STYLE);
                let mut rc = RECT::default();
                let _ = GetWindowRect(self.hwnd, &mut rc);
                let mon = MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(mon, &mut mi).as_bool() {
                    self.fullscreen = Some((style, rc));
                    SetWindowLongPtrW(
                        self.hwnd,
                        GWL_STYLE,
                        style & !(WS_OVERLAPPEDWINDOW.0 as isize),
                    );
                    let r = mi.rcMonitor;
                    let _ = SetWindowPos(
                        self.hwnd,
                        Some(HWND_TOP),
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_FRAMECHANGED,
                    );
                }
            }
        }
    }

    // ── 우클릭 · 더 보기(⋮) 메뉴 ───────────────────────────────────────────
    //
    // 윈도우 기본 팝업 메뉴(TrackPopupMenu)가 아니라 창 안에 직접 그린다 — 모양은 menu.rs · paint.rs. 열려 있는 동안 마우스 · 키보드를 먼저 받는다.
    // 메뉴 막대(Alt)는 그대로 기본 메뉴다.

    fn open_menu(&mut self, at: At) {
        if !self.is_viewer() {
            return;
        }
        let tr = self
            .hooks
            .as_ref()
            .map(|h| h.strings())
            .unwrap_or(self.strings);
        let has_toc = self.view.dock_open || self.view.has_headings();
        let entries = menu::entries(tr, self.view.has_selection(), has_toc);
        let win = (self.view.view_w(), self.view.view_h());
        self.view.popup = Some(Popup::new(&self.view.gfx, entries, at, win));
        unsafe {
            // 방향키 · Enter · Esc 를 이 창이 받아야 한다. 찾기 칸에 초점이 있었다면 닫을 때 돌려준다.
            let f = GetFocus();
            self.menu_prev_focus = if f != self.hwnd { f } else { HWND::default() };
            let _ = SetFocus(Some(self.hwnd));
        }
        self.cursor = Cursor::Arrow;
        self.invalidate();
    }

    /// 메뉴를 닫는다. 닫았으면 true. restore_focus: 찾기 칸에 초점을 돌려줄지(창이 초점을 잃어서 닫는 때는 돌려주지 않는다).
    fn close_menu_with(&mut self, restore_focus: bool) -> bool {
        if self.view.popup.take().is_none() {
            return false;
        }
        // ⋮ 로 열어 붙들어 둔 컨트롤은 같이 걷는다(원래 고정돼 있었다면 그대로 둔다)
        if let Some(was_pinned) = self.menu_ctl.take() {
            if !was_pinned {
                self.hide_controls();
            }
        }
        let prev = std::mem::take(&mut self.menu_prev_focus);
        if restore_focus && !prev.is_invalid() && prev == self.edit && self.view.find_open {
            unsafe {
                let _ = SetFocus(Some(prev));
            }
        }
        self.invalidate();
        true
    }

    fn close_menu(&mut self) -> bool {
        self.close_menu_with(true)
    }

    /// 메뉴가 고른 일을 한다(메뉴는 이미 닫혀 있다)
    fn run_act(&mut self, act: Act) {
        match act {
            Act::Copy => self.copy_selection(),
            Act::SelectAll => {
                self.view.select_all();
                self.invalidate();
            }
            Act::Edit => self.upgrade(Some("edit")),
            Act::Toc => self.toggle_dock(),
            Act::Find => self.open_find(),
            Act::Source => {
                let on = !self.view.plain_view;
                self.view.set_plain_view(on);
                self.after_scroll();
            }
            Act::Open => self.action("open"),
            Act::Print => self.upgrade(Some("print")),
            Act::Pdf => self.upgrade(Some("pdf")),
        }
    }

    /// 우클릭을 뗐다 — 그 자리에 메뉴를 연다(이미 열려 있으면 새 자리에 다시 연다. 메뉴 위의 우클릭은 아무것도 안 한다).
    fn on_right_up(&mut self, x: i32, y: i32) {
        if !self.is_viewer() {
            return;
        }
        let s = self.view.scale();
        let (fx, fy) = (x as f32 / s, y as f32 / s);
        if let Some(p) = &self.view.popup {
            if p.geo.contains(fx, fy) {
                return;
            }
        }
        self.open_menu(At::Point(fx, fy));
    }

    /// 메뉴가 열려 있으면 마우스 움직임을 받는다(받았으면 true). 항목 위로 가면 그 항목이 강조된다 — 웹 메뉴처럼 벗어나도 마지막 강조는 남는다.
    fn menu_move(&mut self, x: i32, y: i32) -> bool {
        let s = self.view.scale();
        let Some(p) = self.view.popup.as_mut() else {
            return false;
        };
        let (fx, fy) = (x as f32 / s, y as f32 / s);
        if let Some(i) = p.item_at(fx, fy) {
            if p.act_at(i).is_some() && p.hot != Some(i) {
                p.hot = Some(i);
                self.invalidate();
            }
        }
        self.cursor = Cursor::Arrow;
        true
    }

    /// 메뉴가 열려 있으면 마우스 누름을 받는다(받았으면 true). 메뉴 밖을 누르면 닫기만 하고, 그 누름은 문서로 새지 않는다.
    fn menu_down(&mut self, x: i32, y: i32) -> bool {
        let s = self.view.scale();
        let Some(p) = self.view.popup.as_mut() else {
            return false;
        };
        let (fx, fy) = (x as f32 / s, y as f32 / s);
        if p.geo.contains(fx, fy) {
            p.pressed = p.item_at(fx, fy).filter(|&i| p.act_at(i).is_some());
            if p.pressed.is_some() {
                p.hot = p.pressed;
            }
            self.invalidate();
        } else {
            self.close_menu();
        }
        true
    }

    /// 메뉴가 열려 있으면 마우스 뗌을 받는다(받았으면 true). 누른 항목 위에서 뗐을 때 실행한다.
    fn menu_up(&mut self, x: i32, y: i32) -> bool {
        let s = self.view.scale();
        let Some(p) = self.view.popup.as_mut() else {
            return false;
        };
        let (fx, fy) = (x as f32 / s, y as f32 / s);
        let pressed = p.pressed.take();
        let act = match (pressed, p.item_at(fx, fy)) {
            (Some(a), Some(b)) if a == b => p.act_at(a),
            _ => None,
        };
        if let Some(act) = act {
            self.close_menu();
            self.run_act(act);
        }
        true
    }

    /// 메뉴가 열려 있으면 키를 받는다(받았으면 true). ↑ ↓ Home End 로 옮기고 Enter · Space 로 고르고 Esc · Tab 으로 닫는다.
    /// 그 밖의 키는 메뉴를 닫고 평소대로 처리한다(Ctrl+F 가 메뉴를 닫고 찾기를 연다). Shift · Ctrl · Alt 만 누른 것은 건드리지 않는다.
    fn menu_key(&mut self, vk: VIRTUAL_KEY) -> bool {
        let Some(p) = self.view.popup.as_mut() else {
            return false;
        };
        match vk {
            VK_ESCAPE | VK_TAB => {
                self.close_menu();
            }
            VK_DOWN => {
                p.hot = menu::step(&p.entries, p.hot, 1);
                self.invalidate();
            }
            VK_UP => {
                p.hot = menu::step(&p.entries, p.hot, -1);
                self.invalidate();
            }
            VK_HOME => {
                p.hot = menu::first_enabled(&p.entries);
                self.invalidate();
            }
            VK_END => {
                p.hot = menu::last_enabled(&p.entries);
                self.invalidate();
            }
            VK_RETURN | VK_SPACE => {
                let act = p.hot.and_then(|i| p.act_at(i));
                if let Some(act) = act {
                    self.close_menu();
                    self.run_act(act);
                }
            }
            VK_SHIFT | VK_CONTROL | VK_MENU | VK_LWIN | VK_RWIN | VK_CAPITAL => return false,
            _ => {
                self.close_menu();
                return false;
            }
        }
        true
    }

    /// 창 모양(논리 px). 최대화 · 전체 화면 · 최소화이면 None.
    fn current_bounds(&self) -> Option<Bounds> {
        unsafe {
            if self.fullscreen.is_some()
                || IsZoomed(self.hwnd).as_bool()
                || IsIconic(self.hwnd).as_bool()
            {
                return None;
            }
            let (mut outer, mut client) = (RECT::default(), RECT::default());
            GetWindowRect(self.hwnd, &mut outer).ok()?;
            GetClientRect(self.hwnd, &mut client).ok()?;
            let scale = GetDpiForWindow(self.hwnd).max(96) as f64 / 96.0;
            Some(Bounds {
                width: (client.right - client.left) as f64 / scale,
                height: (client.bottom - client.top) as f64 / scale,
                x: Some(outer.left as f64 / scale),
                y: Some(outer.top as f64 / scale),
            })
        }
    }
}

/// 팝업 메뉴(우클릭 · 메뉴 막대)를 앱 테마에 맞춘다. uxtheme 의 문서화되지 않은 서수(135: SetPreferredAppMode, 136: FlushMenuThemes)를 쓴다 —
/// 없는 Windows 에서는 조용히 넘어가 기본(밝은) 메뉴로 남는다. 프로세스 전체에 걸리지만 앱의 테마와 같은 방향이라 웹 창의 메뉴도 어긋나지 않는다.
fn set_menu_mode(dark: bool) {
    use windows::core::PCSTR;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    unsafe {
        let Ok(m) = LoadLibraryW(w!("uxtheme.dll")) else {
            return;
        };
        if let Some(f) = GetProcAddress(m, PCSTR(135 as *const u8)) {
            // 2 = ForceDark, 3 = ForceLight
            let f: extern "system" fn(i32) -> i32 = std::mem::transmute(f);
            f(if dark { 2 } else { 3 });
        }
        if let Some(f) = GetProcAddress(m, PCSTR(136 as *const u8)) {
            let f: extern "system" fn() = std::mem::transmute(f);
            f();
        }
    }
}

fn colorref(c: [f32; 4]) -> COLORREF {
    let r = (c[0] * 255.0).round() as u32;
    let g = (c[1] * 255.0).round() as u32;
    let b = (c[2] * 255.0).round() as u32;
    COLORREF(r | (g << 8) | (b << 16))
}

fn wheel_lines() -> u32 {
    unsafe {
        let mut lines: u32 = 3;
        let _ = SystemParametersInfoW(
            SPI_GETWHEELSCROLLLINES,
            0,
            Some(&mut lines as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        // 0 은 '줄 단위가 아님', u32::MAX 는 한 화면씩 — 둘 다 기본 3 으로 본다
        if lines == 0 || lines == u32::MAX {
            3
        } else {
            lines.min(30)
        }
    }
}

// ── 창 프로시저 ────────────────────────────────────────────────────────────

/// 찾기 입력칸(EDIT)을 감싼다 — Enter · Esc · F3 · Ctrl+키를 부모에게 넘긴다.
unsafe extern "system" fn edit_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let old: WNDPROC = std::mem::transmute::<isize, WNDPROC>(EDIT_OLD.load(Ordering::SeqCst));
    match msg {
        WM_KEYDOWN => {
            let vk = VIRTUAL_KEY(wp.0 as u16);
            let ctrl = GetKeyState(VK_CONTROL.0 as i32) < 0;
            let forward = matches!(vk, VK_RETURN | VK_ESCAPE | VK_F3)
                || (ctrl
                    && matches!(
                        vk,
                        VK_F | VK_T
                            | VK_U
                            | VK_E
                            | VK_P
                            | VK_O
                            | VK_W
                            | VK_Q
                            | VK_OEM_PLUS
                            | VK_OEM_MINUS
                            | VK_ADD
                            | VK_SUBTRACT
                            | VK_0
                            | VK_NUMPAD0
                    ))
                || vk == VK_F11;
            if forward {
                if let Ok(parent) = GetParent(hwnd) {
                    let shift = GetKeyState(VK_SHIFT.0 as i32) < 0;
                    let _ = SendMessageW(
                        parent,
                        WM_FIND_KEY,
                        Some(WPARAM(vk.0 as usize)),
                        Some(LPARAM(shift as isize)),
                    );
                    return LRESULT(0);
                }
            }
        }
        // Enter · Esc 가 글자로 들어가 경고음이 나지 않게
        WM_CHAR if wp.0 == 13 || wp.0 == 27 => return LRESULT(0),
        _ => {}
    }
    CallWindowProcW(old, hwnd, msg, wp, lp)
}

/// 창 프로시저. 메시지 하나를 처리하다 패닉하면 그 메시지만 버리고 창은 계속 돈다 — `extern "system"` 안의 패닉은 프로세스를 통째로 끝내므로
/// (열려 있는 모든 창이 같이 사라진다) 한 번 그리다 틀린 것이 앱 전체를 죽이지 않게 막는다.
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wndproc_inner(hwnd, msg, wp, lp)
    })) {
        Ok(r) => r,
        Err(_) => {
            crate::trace::mark(&format!("wndproc-panic msg={msg:#x}"));
            // 닫기 · 파괴는 어쨌든 처리한다(창이 영영 안 닫히면 안 된다)
            if msg == WM_CLOSE {
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
    }
}

unsafe fn wndproc_inner(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    let st = if ptr.is_null() { None } else { Some(&mut *ptr) };
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        // 어두운 테마의 메뉴 막대: Windows 는 막대를 늘 밝게 그리므로 직접 칠한다(darkbar.rs)
        darkbar::WM_UAHDRAWMENU => {
            if let Some(st) = &st {
                if st.view.dark && st.bar_visible && darkbar::draw_bar(hwnd, lp) {
                    return LRESULT(1);
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        darkbar::WM_UAHDRAWMENUITEM => {
            if let Some(st) = &st {
                if st.view.dark && st.bar_visible && darkbar::draw_item(lp) {
                    return LRESULT(1);
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_NCPAINT | WM_NCACTIVATE => {
            let r = DefWindowProcW(hwnd, msg, wp, lp);
            if let Some(st) = &st {
                if st.view.dark && st.bar_visible {
                    darkbar::cover_bottom_line(hwnd);
                }
            }
            r
        }
        WM_PAINT => {
            if let Some(st) = st {
                let rt: ID2D1RenderTarget = st.rt.cast().expect("rt");
                st.view.paint(&rt);
                st.start_image_loads();
            }
            let _ = ValidateRect(Some(hwnd), None);
            LRESULT(0)
        }
        WM_SIZE => {
            if let Some(st) = st {
                let (w, h) = ((lp.0 & 0xffff) as u32, ((lp.0 >> 16) & 0xffff) as u32);
                st.on_size(w, h);
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            if let Some(st) = st {
                let dpi = (wp.0 & 0xffff) as f32;
                let r = &*(lp.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                st.close_menu();
                st.view.dpi = dpi / 96.0;
                st.view.relayout();
                st.kick_layout();
                st.update_edit_font();
                st.layout_find_edit();
                st.invalidate();
            }
            LRESULT(0)
        }
        WM_CMDS => {
            if let Some(st) = st {
                st.run_cmds();
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            if let Some(st) = st {
                st.on_mouse_move(lo(lp), hi(lp));
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            if let Some(st) = st {
                st.leave_tracked = false;
                st.view.ui_hover = None;
                st.view.dock_hover = None;
                st.view.thumb_hot = false;
                st.invalidate();
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            if let Some(st) = st {
                if (lp.0 & 0xffff) as u32 == HTCLIENT {
                    let id = match st.cursor {
                        Cursor::Arrow => IDC_ARROW,
                        Cursor::IBeam => IDC_IBEAM,
                        Cursor::Hand => IDC_HAND,
                    };
                    if let Ok(c) = LoadCursorW(None, id) {
                        SetCursor(Some(c));
                        return LRESULT(1);
                    }
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
            if let Some(st) = st {
                if st.is_viewer() && !st.menu_down(lo(lp), hi(lp)) {
                    st.on_button_down(lo(lp), hi(lp));
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            if let Some(st) = st {
                if !st.menu_up(lo(lp), hi(lp)) {
                    st.on_button_up(lo(lp), hi(lp));
                }
            }
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            if let Some(st) = st {
                st.on_right_up(lo(lp), hi(lp));
            }
            LRESULT(0)
        }
        // 창이 초점을 잃으면(다른 창 · 찾기 칸을 눌렀다) 열린 메뉴는 닫힌다. 초점을 돌려주지 않는다 — 이미 다른 곳이 가졌다.
        WM_KILLFOCUS => {
            if let Some(st) = st {
                st.close_menu_with(false);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
            if let Some(st) = st {
                let delta = ((wp.0 >> 16) & 0xffff) as u16 as i16 as i32;
                // 휠 좌표는 화면 기준이다
                let mut p = POINT {
                    x: lo(lp),
                    y: hi(lp),
                };
                let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut p);
                st.on_wheel(delta, p.x, p.y, msg == WM_MOUSEHWHEEL);
            }
            LRESULT(0)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            if let Some(st) = st {
                let vk = VIRTUAL_KEY(wp.0 as u16);
                // 메뉴가 열려 있으면 메뉴가 먼저 받는다(방향키 · Enter · Esc …)
                if st.menu_key(vk) {
                    return LRESULT(0);
                }
                if vk == VK_MENU {
                    // Alt 단독: 떼는 순간 메뉴 막대를 보이거나 숨긴다(다른 키가 끼면 취소). 눌러 두어 반복되는 것은 한 번으로 친다.
                    if (lp.0 & (1 << 30)) == 0 {
                        st.alt_alone = true;
                    }
                    return LRESULT(0);
                }
                st.alt_alone = false;
                if st.on_key(vk) {
                    return LRESULT(0);
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_KEYUP | WM_SYSKEYUP => {
            if let Some(st) = st {
                if wp.0 as u16 == VK_MENU.0 {
                    if st.alt_alone {
                        st.alt_alone = false;
                        st.toggle_bar();
                    }
                    return LRESULT(0);
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_INITMENUPOPUP => {
            // 메뉴가 열릴 때마다 체크 표시를 지금 상태로 맞춘다
            if let Some(st) = st {
                if let (Some(bar), Some(h)) = (&st.bar, &st.hooks) {
                    bar.update(&h.menu_state());
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_SETTINGCHANGE => {
            // 시스템 테마가 바뀌면(설정이 시스템일 때) 따라간다
            if let Some(st) = st {
                // 스크린 리더가 켜졌다(SPI_SETSCREENREADER = 0x47) — 네이티브로 그린 글은 읽어 줄 수 없으니 웹 창으로 넘긴다
                if wp.0 == 0x47 && st.is_viewer() && screen_reader_active() {
                    st.upgrade(None);
                }
                if lp.0 != 0 {
                    let name = PCWSTR(lp.0 as *const u16).to_string().unwrap_or_default();
                    if name == "ImmersiveColorSet"
                        && st
                            .hooks
                            .as_ref()
                            .map(|h| h.theme_setting() == "system")
                            .unwrap_or(false)
                    {
                        st.set_theme(system_dark());
                    }
                }
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_FIND_KEY => {
            if let Some(st) = st {
                let vk = VIRTUAL_KEY(wp.0 as u16);
                let shift = lp.0 != 0;
                match vk {
                    VK_RETURN => st.find_step(if shift { -1 } else { 1 }),
                    VK_ESCAPE => st.close_find(),
                    VK_F3 => st.find_step(if shift { -1 } else { 1 }),
                    // Ctrl+F: 이미 열려 있다 — 칸에 초점을 두고 글을 모두 고른다
                    VK_F => {
                        let _ = SetFocus(Some(st.edit));
                        SendMessageW(st.edit, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(-1)));
                    }
                    other => {
                        // 나머지 단축키는 본문과 같다(Ctrl 이 눌린 채 넘어온다)
                        let _ = st.on_key(other);
                    }
                }
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            if let Some(st) = st {
                let code = ((wp.0 >> 16) & 0xffff) as u32;
                let id = (wp.0 & 0xffff) as u32;
                if lp.0 == 0 && code == 0 {
                    // 메뉴 항목
                    let name = st
                        .bar
                        .as_ref()
                        .and_then(|b| b.name_of(id))
                        .map(str::to_string);
                    if let Some(n) = name {
                        st.run_menu_action(&n);
                    }
                // EN_CHANGE = 0x0300
                } else if code == 0x0300 && lp.0 == st.edit.0 as isize {
                    // 한 글자마다 문서를 훑지 않는다 — 120ms 쉬었을 때만(한글 IME 는 마지막 글자를 조합 중인 채 멈춘다)
                    st.find_dirty = true;
                    SetTimer(Some(hwnd), FIND_TIMER, 120, None);
                }
            }
            LRESULT(0)
        }
        WM_CTLCOLOREDIT => {
            if let Some(st) = st {
                let hdc = HDC(wp.0 as *mut _);
                let pal = palette(st.view.dark);
                SetTextColor(hdc, colorref(pal[super::layout::Col::Fg as usize]));
                SetBkColor(hdc, colorref(pal[super::layout::Col::CodeInline as usize]));
                return LRESULT(st.edit_brush.0 as isize);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_DROPFILES => {
            if let Some(st) = st {
                let drop = HDROP(wp.0 as *mut _);
                let n = DragQueryFileW(drop, 0, None);
                if n > 0 {
                    let len = DragQueryFileW(drop, 0, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    let got = DragQueryFileW(drop, 0, Some(&mut buf)) as usize;
                    let p = PathBuf::from(String::from_utf16_lossy(&buf[..got]));
                    if let Some(h) = &st.hooks {
                        h.dropped(p);
                    }
                }
                DragFinish(drop);
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if let Some(st) = st {
                match wp.0 {
                    LAYOUT_TIMER => {
                        // 첫 화면 밖의 나머지를 틈틈이 놓는다. 타이머는 입력보다 뒤라 스크롤 · 닫기가 밀리지 않는다.
                        let before = st.view.layout.height;
                        if st.view.more(f32::MAX, Some(Instant::now() + SLICE)) {
                            let _ = KillTimer(Some(hwnd), LAYOUT_TIMER);
                        }
                        if (st.view.layout.height - before).abs() > 0.5 {
                            st.view.clamp();
                            st.invalidate();
                        }
                    }
                    SCROLL_TIMER => {
                        if !st.view.tick_scroll() {
                            let _ = KillTimer(Some(hwnd), SCROLL_TIMER);
                        }
                        st.publish_scroll();
                        if st.view.dock_open {
                            st.view.follow_active_in_dock();
                        }
                        st.invalidate();
                    }
                    AUTOSCROLL_TIMER => {
                        // 끌어서 고르는 중 창 밖에 마우스가 있으면 그쪽으로 굴리며 고른 끝을 늘린다
                        let (mx, my) = st.mouse;
                        let ch = st.view.ch as i32;
                        let dy = if my < 0 {
                            my as f32 / 2.0
                        } else if my > ch {
                            (my - ch) as f32 / 2.0
                        } else {
                            0.0
                        };
                        if dy != 0.0 {
                            st.view
                                .scroll_to(st.view.scroll + dy.clamp(-60.0, 60.0), false);
                            st.after_scroll();
                            let (fx, fy) = (mx as f32, my.clamp(0, ch - 1) as f32);
                            if let Some(h) = st.view.hit_test(fx, fy) {
                                if let Some(sel) = &mut st.view.sel {
                                    sel.focus = h.pos;
                                }
                            }
                        }
                    }
                    FIND_TIMER => {
                        if st.find_dirty {
                            st.run_find_now();
                        } else {
                            let _ = KillTimer(Some(hwnd), FIND_TIMER);
                        }
                    }
                    CTL_HIDE_TIMER => {
                        if st.view.ctl_pinned {
                            let _ = KillTimer(Some(hwnd), CTL_HIDE_TIMER);
                        } else {
                            st.hide_controls();
                        }
                    }
                    CTL_TAP_TIMER => {
                        let _ = KillTimer(Some(hwnd), CTL_TAP_TIMER);
                        if st.view.ctl_shown {
                            st.hide_controls();
                        } else {
                            st.view.ctl_pinned = true;
                            st.show_controls(false);
                        }
                    }
                    TIP_TIMER => {
                        // 툴팁이 뜰 때가 됐는지 본다(뜬 뒤에는 그만 본다)
                        st.invalidate();
                        if st
                            .view
                            .ctl_hover_since
                            .map(|t| t.elapsed() >= Duration::from_millis(400))
                            .unwrap_or(true)
                        {
                            let _ = KillTimer(Some(hwnd), TIP_TIMER);
                        }
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }
        WM_GETMINMAXINFO => {
            let mmi = &mut *(lp.0 as *mut MINMAXINFO);
            let dpi = GetDpiForWindow(hwnd).max(96) as i32;
            mmi.ptMinTrackSize.x = 360 * dpi / 96;
            mmi.ptMinTrackSize.y = 280 * dpi / 96;
            LRESULT(0)
        }
        WM_CLOSE => {
            if let Some(s) = st {
                match s.mode {
                    Mode::Viewer => {
                        // 닫기 직전의 모양을 앱이 기억한다
                        let b = s.current_bounds();
                        if let Some(h) = s.hooks.clone() {
                            h.closed(b);
                        }
                    }
                    _ => {
                        // 사용자가 미리보기를 닫았다 = 이 문서를 닫겠다는 뜻이다(진짜 창은 아직 안 떴다).
                        if !s.swapped {
                            match s.on_close.clone() {
                                // 둘째 이후 창: 그 문서의 창만 닫는다(다른 창 · 앱은 그대로). 진짜 창이 아직 없으면 뜨는 대로 닫힌다.
                                Some(f) => {
                                    s.close_requested.store(true, Ordering::SeqCst);
                                    f();
                                }
                                // 첫 창: 앱을 닫겠다는 뜻이다.
                                None => std::process::exit(0),
                            }
                        }
                    }
                }
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_SWAP_CLOSE => {
            if let Some(st) = st {
                st.swapped = true;
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            if let Some(s) = st {
                s.slot.store(0, Ordering::SeqCst);
            }
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// 틈틈이 이어 놓을 때 한 번에 쓰는 시간
const SLICE: Duration = Duration::from_millis(6);

/// 문서를 읽을 스레드를 시작한다. 창이 만들어지면 Handle 이 채워진다.
pub fn spawn(params: Params) -> Handle {
    let handle = Handle::new();
    let h2 = handle.clone();
    let _ = std::thread::Builder::new()
        .name("preview".into())
        .stack_size(THREAD_STACK)
        .spawn(move || {
            // 어떤 이유로든 실패하면 조용히 접는다 — 미리보기는 덤이고, 진짜 창이 문서를 보여 준다.
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                run(params, h2.clone())
            }));
            // 창을 못 만들었어도 기다리는 쪽이 영영 막히지 않게 모양을 정해 준다
            if h2.mode() == Mode::Undecided {
                h2.set_mode(Mode::Preview);
            }
            let _ = r;
        });
    handle
}

/// 문서에 이 창이 못 그리는 것이 있는가
fn needs_web(doc: &Doc, remote_images_on: bool) -> bool {
    doc.features.needs_web() || (doc.features.remote_images && remote_images_on)
}

unsafe fn run(mut p: Params, handle: Handle) {
    let slot = handle.hwnd.clone();
    (p.on_event)("preview-start");
    // ★ 글꼴 · 마크다운 준비는 창 · Direct2D 를 만드는 동안 다른 스레드에서 한다(서로 기다릴 일이 없다).
    //   문서부터 읽어 모양(Preview · Viewer)을 먼저 알린다 — 메인 스레드가 WebView2 창을 만들지 말지 거기에 달려 있다.
    let src = Arc::new(std::mem::take(&mut p.src));
    let (native_ok, plain, remote_on) = (p.native_ok, p.plain, p.remote_images);
    let handle_prep = handle.clone();
    let src_prep = src.clone();
    let prep = std::thread::Builder::new()
        .name("preview-prep".into())
        .stack_size(THREAD_STACK)
        .spawn(move || {
            let doc = if plain {
                md::parse_plain(&src_prep)
            } else {
                md::parse(&src_prep)
            };
            let mode = if native_ok && !needs_web(&doc, remote_on) {
                Mode::Viewer
            } else {
                Mode::Preview
            };
            handle_prep.set_mode(mode);
            let dw = DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED).ok()?;
            let gfx = Gfx::new(dw);
            gfx.warm();
            Some((gfx, doc))
        })
        .ok();
    let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let Ok(hinst) = GetModuleHandleW(None) else {
        return;
    };
    let class = w!("MarkletPreview");
    let wc = WNDCLASSW {
        style: CS_DBLCLKS,
        hInstance: hinst.into(),
        lpszClassName: class,
        lpfnWndProc: Some(wndproc),
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        hIcon: LoadIconW(Some(hinst.into()), PCWSTR(32512 as *const u16)).unwrap_or_default(),
        ..Default::default()
    };
    RegisterClassW(&wc);

    // 화면 배율은 시스템 DPI 로 정한다(주 모니터 기준 — Tauri 창이 놓이는 곳과 같다).
    let dpi = GetDpiForSystem().max(96);
    let scale = dpi as f32 / 96.0;

    let (lw, lh, lx, ly) = p.bounds.unwrap_or((980.0, 900.0, None, None));
    let (cw, ch) = (
        (lw as f32 * scale).round() as i32,
        (lh as f32 * scale).round() as i32,
    );
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: cw,
        bottom: ch,
    };
    let style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
    let _ = AdjustWindowRectExForDpi(&mut rc, style, false, WINDOW_EX_STYLE(0), dpi);
    let (ow, oh) = (rc.right - rc.left, rc.bottom - rc.top);
    let (x, y) = match (lx, ly) {
        (Some(x), Some(y)) => {
            let (px, py) = (
                (x as f32 * scale).round() as i32,
                (y as f32 * scale).round() as i32,
            );
            // 저장된 자리가 지금의 어느 모니터에도 안 걸치면(모니터를 뺐다) 기본 자리에 띄운다 — 화면 밖에 뜨면 잡을 수가 없다
            let r = RECT {
                left: px,
                top: py,
                right: px + ow,
                bottom: py + oh.min(64),
            };
            if MonitorFromRect(&r, MONITOR_DEFAULTTONULL).is_invalid() {
                (CW_USEDEFAULT, CW_USEDEFAULT)
            } else {
                (px, py)
            }
        }
        _ => (CW_USEDEFAULT, CW_USEDEFAULT),
    };
    let title: Vec<u16> = p.title.encode_utf16().chain(std::iter::once(0)).collect();
    let Ok(hwnd) = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class,
        PCWSTR(title.as_ptr()),
        style,
        x,
        y,
        ow,
        oh,
        None,
        None,
        Some(hinst.into()),
        None,
    ) else {
        return;
    };
    let on = BOOL(1);
    // ★ 열 때의 페이드 인과 닫을 때의 페이드 아웃을 끈다. 미리보기는 잠깐 있다 가는 창이라, 페이드가 있으면 글이 그려진 뒤에도
    //   창이 반투명한 채로 보이고(처음), 걷은 뒤에도 흐릿한 잔상이 남는다(마지막).
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_TRANSITIONS_FORCEDISABLED,
        &on as *const _ as *const _,
        std::mem::size_of::<BOOL>() as u32,
    );
    if p.dark {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &on as *const _ as *const _,
            std::mem::size_of::<BOOL>() as u32,
        );
    }
    DragAcceptFiles(hwnd, true);
    (p.on_event)("preview-window");

    let Ok(factory) = D2D1CreateFactory::<ID2D1Factory>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)
    else {
        return;
    };
    let mut crc = RECT::default();
    let _ = GetClientRect(hwnd, &mut crc);
    let (pw, ph) = (
        (crc.right - crc.left).max(1) as u32,
        (crc.bottom - crc.top).max(1) as u32,
    );
    let props = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: D2D1_RENDER_TARGET_TYPE_SOFTWARE,
        ..Default::default()
    };
    let hprops = D2D1_HWND_RENDER_TARGET_PROPERTIES {
        hwnd,
        pixelSize: D2D_SIZE_U {
            width: pw,
            height: ph,
        },
        presentOptions: D2D1_PRESENT_OPTIONS_NONE,
    };
    let Ok(rt) = factory.CreateHwndRenderTarget(&props, &hprops) else {
        return;
    };
    (p.on_event)("preview-rt");

    let mut brushes = Brushes {
        b: Vec::with_capacity(COLS),
    };
    for c in palette(p.dark) {
        let Ok(b) = rt.CreateSolidColorBrush(
            &D2D1_COLOR_F {
                r: c[0],
                g: c[1],
                b: c[2],
                a: c[3],
            },
            None,
        ) else {
            return;
        };
        brushes.b.push(b);
    }
    let Some((gfx, doc)) = prep.and_then(|t| t.join().ok()).flatten() else {
        return;
    };
    (p.on_event)("preview-parsed");
    let mode = handle.mode();
    // 덩어리가 너무 커서 이 뷰어로는 첫 화면도 몇 초씩 걸린다 — 미리보기도 두지 않는다(웹 창이 알아서 뜬다)
    if mode != Mode::Viewer && doc.features.huge {
        let _ = DestroyWindow(hwnd);
        return;
    }
    // 측정 도구(px-probe)가 이 창을 '진짜 창'으로 세도록 표시한다(뷰어는 미리보기가 아니라 끝까지 보여 주는 창이다)
    if mode == Mode::Viewer {
        let _ = SetPropW(
            hwnd,
            w!("MarkletViewer"),
            Some(HANDLE(std::ptr::dangling_mut())),
        );
        set_menu_mode(p.dark);
    }

    let strings = p
        .hooks
        .as_ref()
        .map(|h| h.strings())
        .unwrap_or(&crate::strings::KO);
    let ctx = Ctx {
        dir: p
            .path
            .as_ref()
            .and_then(|f| f.parent().map(|d| d.to_path_buf())),
        fm_open: false,
        remote_images: p.remote_images,
        korean: p.korean,
    };
    let mut view = View::new(gfx, brushes, doc, src, ctx);
    view.dark = p.dark;
    view.zoom = p.zoom as f32;
    view.dpi = scale;
    view.cw = pw;
    view.ch = ph;
    view.plain_view = p.plain;
    // 연구용: 미리보기를 이 높이(CSS px)까지 내려 둔 채로 시작한다(렌더러와 위치를 맞대 보려는 것).
    let start_scroll: f32 = std::env::var("MARKLET_PREVIEW_SCROLL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    view.scroll = start_scroll;
    view.scroll_target = start_scroll;
    let rt_hwnd = rt.cast::<ID2D1HwndRenderTarget>().unwrap_or(rt);

    let mut st = Box::new(State {
        hwnd,
        rt: rt_hwnd,
        view,
        mode,
        hooks: p.hooks.clone(),
        handle: handle.clone(),
        swapped: false,
        on_close: p.on_close.clone(),
        strings,
        drag: Drag::None,
        moved: false,
        press_link: None,
        last_click: (Instant::now(), 0, 0, 0),
        cursor: Cursor::Arrow,
        leave_tracked: false,
        mouse: (0, 0),
        edit: HWND::default(),
        edit_font: HFONT::default(),
        edit_brush: CreateSolidBrush(colorref(
            palette(p.dark)[super::layout::Col::CodeInline as usize],
        )),
        find_dirty: false,
        fullscreen: None,
        img_queue: VecDeque::new(),
        img_active: 0,
        bar: None,
        bar_visible: false,
        alt_alone: false,
        ctl_last: (-1, -1),
        menu_prev_focus: HWND::default(),
        menu_ctl: None,
        scroll_out: handle.scroll.clone(),
        slot: handle.hwnd.clone(),
        close_requested: handle.close_requested.clone(),
    });
    st.view.relayout();
    // 처음부터 아래쪽에서 시작하는 경우(연구용 환경변수)에도 그 자리가 놓여 있게
    st.view.ensure();
    st.view.clamp();
    st.publish_scroll();
    (p.on_event)("preview-layout");
    let rt_draw: ID2D1RenderTarget = st.rt.cast().expect("rt");
    st.view.paint(&rt_draw);
    (p.on_event)("preview-paint");
    if p.dry_run {
        let _ = DestroyWindow(hwnd);
        return;
    }
    let more = !st.view.is_done();
    let st_ptr = Box::into_raw(st);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, st_ptr as isize);
    slot.store(hwnd.0 as isize, Ordering::SeqCst);
    // ★ 큰 문서는 첫 화면을 그리는 사이에 진짜 창이 먼저 떠서 이어받았을 수 있다. 그러면 이 창은 뜨지 않고 접는다 —
    //   뒤늦게 떠서 진짜 창을 덮고, 닫으면 앱이 같이 끝나는 유령 창이 되면 안 된다.
    if handle.cancelled.load(Ordering::SeqCst) {
        let _ = DestroyWindow(hwnd);
        drop(Box::from_raw(st_ptr));
        return;
    }
    let _ = ShowWindow(hwnd, SW_SHOW);
    // 앱이 떠 있는 동안 연 문서의 창은 앞으로 나와야 한다(허락되지 않으면 작업 표시줄이 깜빡일 뿐이다)
    if mode == Mode::Viewer {
        let _ = SetForegroundWindow(hwnd);
    }
    // 화면 장치의 그림 요청(그려 보다가 알게 된 것)
    (&mut *st_ptr).start_image_loads();
    (p.on_event)("preview-shown");
    if more {
        SetTimer(Some(hwnd), LAYOUT_TIMER, 10, None);
    }

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    drop(Box::from_raw(st_ptr));
}

/// 시스템이 어두운 앱 테마인가(설정의 '시스템' 테마용).
pub fn system_dark() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    unsafe {
        let mut v: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let r = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut v as *mut u32 as *mut _),
            Some(&mut size),
        );
        r.is_ok() && v == 0
    }
}

/// 스크린 리더(화면 읽기 프로그램)가 켜져 있는가. 켜져 있으면 네이티브로 그린 글은 읽어 줄 수 없으니(접근성 트리가 없다) WebView2 렌더러를 쓴다.
pub fn screen_reader_active() -> bool {
    unsafe {
        let mut on = BOOL(0);
        let _ = SystemParametersInfoW(
            SPI_GETSCREENREADER,
            0,
            Some(&mut on as *mut BOOL as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        on.as_bool()
    }
}

#[allow(dead_code)]
fn _unused(_: Pos, _: &HFONT) {}
