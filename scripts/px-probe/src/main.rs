//! 눈에 보이는 시작 시각 측정기. 사용: px-probe <글자가장자리수> <제한ms> <exe> [인자...]
//! 실행 직전부터 그 프로세스의 보이는 창을 PrintWindow 로 계속 떠서, 본문 영역(제목 표시줄 아래)에
//! **글자가 있다고 볼 만큼의 가장자리(밝기가 확 바뀌는 곳)**가 처음 생기는 시각(ms)을 출력한다. 못 찾으면 -1.
//!
//! 짙은 픽셀 수를 세던 첫 판은 속았다: 아직 그려지지 않은 창을 PrintWindow 하면 검은 화면이 돌아오는데, 그것이 "짙은 픽셀"로 셌다.
//! 가장자리는 균일한 화면(검정 · 흰색 · 어두운 테마의 배경)에는 없고 글자에는 많다 — 테마와 상관없이 글자만 가려낸다.
//!
//! 환경변수 PX_SAVE=<폴더> 가 있으면 창마다 처음 뜬 화면(first)과 글자가 처음 보인 화면(hit)을 BMP 로 남긴다 — 눈으로 확인하려는 것이다.
//! 출력: `보인시각 글자시각 최종시각 끊김횟수` (ms)
mod act;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use windows::core::BOOL;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::PrintWindow;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::*;

struct Ctx {
    pid: u32,
    list: Vec<HWND>,
}

unsafe extern "system" fn enum_proc(h: HWND, l: LPARAM) -> BOOL {
    let ctx = &mut *(l.0 as *mut Ctx);
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, Some(&mut pid));
    if pid == ctx.pid && IsWindowVisible(h).as_bool() {
        ctx.list.push(h);
    }
    BOOL(1)
}

struct Shot {
    w: i32,
    h: i32,
    px: Vec<u32>,
}

unsafe fn capture(h: HWND) -> Option<Shot> {
    let mut r = RECT::default();
    GetWindowRect(h, &mut r).ok()?;
    let (w, ht) = (r.right - r.left, r.bottom - r.top);
    if w < 400 || ht < 300 {
        return None;
    }
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -ht; // 위에서 아래로
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB.0;
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(mem), &bi, DIB_RGB_COLORS, &mut bits, None, 0);
    let mut out = None;
    if let Ok(bmp) = bmp {
        let old = SelectObject(mem, bmp.into());
        let _ = PrintWindow(h, mem, windows::Win32::Storage::Xps::PRINT_WINDOW_FLAGS(2));
        let px = std::slice::from_raw_parts(bits as *const u32, (w * ht) as usize).to_vec();
        out = Some(Shot { w, h: ht, px });
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
    }
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    out
}

fn luma(c: u32) -> i32 {
    let (b, g, r) = ((c & 255) as i32, ((c >> 8) & 255) as i32, ((c >> 16) & 255) as i32);
    (b * 29 + g * 150 + r * 77) >> 8
}

/// 가로로 이웃한 두 픽셀의 밝기가 크게 다른 곳의 수(2행마다 표본). 글자가 많을수록 크다. 균일한 화면은 0.
fn edges(s: &Shot, skip_top: i32) -> usize {
    let mut n = 0usize;
    for y in (skip_top..s.h).step_by(2) {
        let row = &s.px[(y * s.w) as usize..((y + 1) * s.w) as usize];
        for x in 0..(s.w as usize - 1) {
            if (luma(row[x]) - luma(row[x + 1])).abs() >= 100 {
                n += 1;
            }
        }
    }
    n
}

fn mean_luma(s: &Shot) -> i32 {
    let mut sum = 0i64;
    let mut n = 0i64;
    for y in (0..s.h).step_by(8) {
        for x in (0..s.w).step_by(8) {
            sum += luma(s.px[(y * s.w + x) as usize]) as i64;
            n += 1;
        }
    }
    (sum / n.max(1)) as i32
}

fn save_bmp(dir: &str, name: &str, s: &Shot) {
    let size = (s.w * s.h * 4) as u32;
    let mut b: Vec<u8> = Vec::with_capacity(54 + size as usize);
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&(54 + size).to_le_bytes());
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(&54u32.to_le_bytes());
    b.extend_from_slice(&40u32.to_le_bytes());
    b.extend_from_slice(&s.w.to_le_bytes());
    b.extend_from_slice(&(-s.h).to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&size.to_le_bytes());
    b.extend_from_slice(&[0; 16]);
    for p in &s.px {
        b.extend_from_slice(&p.to_le_bytes());
    }
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(std::path::Path::new(dir).join(name), b);
}


/// 화면(DWM 이 합성한 결과)에서 사각형 하나를 뜬다. PrintWindow 와 달리 **사용자 눈에 실제로 보이는 것**이다(가려진 창은 가린 것이 찍힌다).
unsafe fn capture_screen(r: RECT) -> Option<Shot> {
    let (w, ht) = (r.right - r.left, r.bottom - r.top);
    if w < 200 || ht < 200 {
        return None;
    }
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -ht;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB.0;
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(mem), &bi, DIB_RGB_COLORS, &mut bits, None, 0);
    let mut out = None;
    if let Ok(bmp) = bmp {
        let old = SelectObject(mem, bmp.into());
        // CAPTUREBLT: 겹친(layered) 창도 함께 찍는다
        let _ = BitBlt(mem, 0, 0, w, ht, Some(screen), r.left, r.top, SRCCOPY | CAPTUREBLT);
        let px = std::slice::from_raw_parts(bits as *const u32, (w * ht) as usize).to_vec();
        out = Some(Shot { w, h: ht, px });
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
    }
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    out
}

fn pid_of(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

/// 화면 기준 측정(PX_SCREEN=1). 앱 창의 본문 영역을 화면에서 계속 떠서, 맨 위에 보이는 창이 우리 것일 때만 센다.
/// 출력: `보인시각 글자시각 최종시각 끊김횟수 가려진횟수` — 끊김 = 글자가 한 번 보인 뒤 우리 창이 맨 위인데 글자가 없던 표본(사용자가 본 빈 화면).
fn run_screen(child: &mut std::process::Child, t0: Instant, limit: Duration, min_edges: usize) {
    let pid = child.id();
    let (mut vis, mut hit, mut fin) = (-1i64, -1i64, -1i64);
    let (mut gaps, mut occluded, mut samples) = (0u32, 0u32, 0u32);
    let mut after_fin: Option<Instant> = None;
    let mut last_blank: i64 = -1;
    let (mut saved, mut last_text) = (0u32, false);
    while t0.elapsed() < limit {
        if let Some(t) = after_fin {
            if t.elapsed() > Duration::from_millis(600) {
                break;
            }
        }
        let mut ctx = Ctx { pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            // 클라이언트 영역이 가장 큰 창(= 본문이 있는 창)을 기준으로
            let mut best: Option<RECT> = None;
            for h in &ctx.list {
                let mut c = RECT::default();
                if GetClientRect(*h, &mut c).is_err() {
                    continue;
                }
                let mut tl = POINT { x: c.left, y: c.top };
                let _ = ClientToScreen(*h, &mut tl);
                let rc = RECT { left: tl.x, top: tl.y, right: tl.x + (c.right - c.left), bottom: tl.y + (c.bottom - c.top) };
                if rc.right - rc.left >= 400 && rc.bottom - rc.top >= 300 {
                    if best.map(|b| (b.right - b.left) * (b.bottom - b.top) < (rc.right - rc.left) * (rc.bottom - rc.top)).unwrap_or(true) {
                        best = Some(rc);
                    }
                }
            }
            let Some(rc) = best else {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            };
            let now = t0.elapsed().as_millis() as i64;
            if vis < 0 {
                vis = now;
            }
            // 본문 영역 안쪽의 한 점에서 맨 위 창이 누구인가
            let center = POINT { x: (rc.left + rc.right) / 2, y: (rc.top + rc.bottom) / 2 };
            let top = GetAncestor(WindowFromPoint(center), GA_ROOT);
            if top.0.is_null() || pid_of(top) != pid {
                occluded += 1;
                continue;
            }
            let cls = class_of(top);
            let Some(shot) = capture_screen(rc) else { continue };
            // 캡처 직후에도 같은 창이 맨 위인가(그 사이에 바뀌었으면 버린다)
            let top2 = GetAncestor(WindowFromPoint(center), GA_ROOT);
            if top2 != top {
                continue;
            }
            samples += 1;
            let e = edges(&shot, 0);
            if let Ok(dir) = std::env::var("PX_SAVE") {
                // 연구용: 처음 몇 장과 글자 있는/없는 전환 순간을 BMP 로 남긴다
                if saved < 40 && (samples <= 3 || (e >= min_edges) != last_text) {
                    saved += 1;
                    save_bmp(&dir, &format!("s{:02}-{}-{}ms-edges{}.bmp", saved, cls, now, e), &shot);
                }
            }
            last_text = e >= min_edges;
            if e >= min_edges {
                if hit < 0 {
                    hit = now;
                }
                if fin < 0 && cls != "MarkletPreview" {
                    fin = now;
                    after_fin = Some(Instant::now());
                }
            } else if hit >= 0 {
                gaps += 1;
                last_blank = now;
            }
        }
    }
    let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = child.wait();
    println!("{vis} {hit} {fin} {gaps} {occluded} {samples} {last_blank}");
}


/// 이미 떠 있는 앱(attach_pid)에 또 문서를 열게 했을 때, **새로 생긴 창**에 글자가 보이기까지(PX_ATTACH=<pid>).
/// 새로 띄운 프로세스(child)는 문서를 넘기고 곧 끝난다 — 창은 이미 떠 있던 프로세스에 생긴다.
/// 출력: `새창이보인시각 글자시각` (ms, 새 프로세스를 띄운 직후=0)
fn run_attach(attach_pid: u32, child: &mut std::process::Child, t0: Instant, limit: Duration, min_edges: usize) {
    let snapshot = || {
        let mut ctx = Ctx { pid: attach_pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
        }
        ctx.list
    };
    let before: Vec<HWND> = snapshot();
    let (mut vis, mut hit, mut fin) = (-1i64, -1i64, -1i64);
    let mut saved = 0u32;
    let mut after: Option<Instant> = None;
    while t0.elapsed() < limit {
        if let Some(t) = after {
            if t.elapsed() > Duration::from_millis(100) {
                break;
            }
        }
        let mut news: Vec<HWND> = snapshot().into_iter().filter(|h| !before.contains(h)).collect();
        // 미리보기가 떠 있는 동안은 사용자 눈에 그것만 보인다(진짜 창은 그 뒤에 가려 있다) — 첫 실행 측정과 같은 규칙.
        let has_preview = news.iter().any(|h| class_of(*h) == "MarkletPreview");
        if has_preview {
            news.retain(|h| class_of(*h) == "MarkletPreview");
        }
        for h in news {
            let now = t0.elapsed().as_millis() as i64;
            unsafe {
                let mut r = RECT::default();
                if GetWindowRect(h, &mut r).is_ok() && r.right - r.left >= 400 && r.bottom - r.top >= 300 && vis < 0 {
                    vis = now;
                }
                if let Some(shot) = capture(h) {
                    let e = edges(&shot, 90);
                    if let Ok(dir) = std::env::var("PX_SAVE") {
                        if saved < 12 && (saved < 2 || e >= min_edges) {
                            saved += 1;
                            save_bmp(&dir, &format!("a{:02}-{:x}-{}ms-edges{}.bmp", saved, h.0 as isize, now, e), &shot);
                        }
                    }
                    if e >= min_edges {
                        if hit < 0 {
                            hit = now;
                        }
                        if fin < 0 && class_of(h) != "MarkletPreview" {
                            fin = now;
                            after = Some(Instant::now());
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let _ = child.kill();
    let _ = child.wait();
    println!("{vis} {hit} {fin}");
}

fn class_of(h: HWND) -> String {
    let mut name = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut name) } as usize;
    let c = String::from_utf16_lossy(&name[..n]);
    // 네이티브 뷰어(문서를 끝까지 보여 주는 창)는 미리보기와 같은 클래스에 표시만 다르다 — 진짜 창으로 센다.
    if c == "MarkletPreview" && unsafe { !GetPropW(h, windows::core::w!("MarkletViewer")).0.is_null() } {
        return "MarkletView".to_string();
    }
    c
}

/// PX_ACT=<pid> PX_SCRIPT=... : 진짜 입력을 창에 넣는다(act.rs). shot:이름 은 PX_OUT 폴더에 BMP 로 남긴다.
fn act_mode() -> bool {
    let Ok(v) = std::env::var("PX_ACT") else {
        return false;
    };
    let pid: u32 = v.parse().unwrap_or(0);
    let script = std::env::var("PX_SCRIPT").unwrap_or_default();
    let dir = std::env::var("PX_OUT").unwrap_or_else(|_| ".".into());
    let mut ctx = Ctx { pid, list: Vec::new() };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
        let mut best: Option<(HWND, i32)> = None;
        for h in &ctx.list {
            let mut r = RECT::default();
            let _ = GetWindowRect(*h, &mut r);
            let area = (r.right - r.left) * (r.bottom - r.top);
            if area > 100 * 100 && best.map(|b| area > b.1).unwrap_or(true) {
                best = Some((*h, area));
            }
        }
        let Some((hwnd, _)) = best else {
            println!("no window");
            return true;
        };
        act::run(hwnd, &script, &|h, name| {
            if let Some(n) = name.strip_prefix("screen:") {
                let mut r = RECT::default();
                let _ = GetWindowRect(h, &mut r);
                let rc = RECT { left: (r.left - 40).max(0), top: (r.top - 40).max(0), right: r.right + 260, bottom: r.bottom + 40 };
                if let Some(shot) = capture_screen(rc) {
                    save_bmp(&dir, &format!("{n}.bmp"), &shot);
                    println!("shot={n} {}x{} (screen)", shot.w, shot.h);
                }
                return;
            }
            if let Some(shot) = capture(h) {
                save_bmp(&dir, &format!("{name}.bmp"), &shot);
                println!("shot={name} {}x{}", shot.w, shot.h);
            }
        });
    }
    true
}

/// PX_SHOT=<pid> PX_OUT=<파일.bmp>: 그 프로세스에서 가장 큰 보이는 창을 한 장 떠서 저장한다.
fn shot_mode() -> bool {
    let Ok(v) = std::env::var("PX_SHOT") else { return false };
    let pid: u32 = v.parse().unwrap_or(0);
    let out = std::env::var("PX_OUT").unwrap_or_else(|_| "shot.bmp".into());
    let mut ctx = Ctx { pid, list: Vec::new() };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
        let mut best: Option<(HWND, i32)> = None;
        for h in &ctx.list {
            let mut r = RECT::default();
            let _ = GetWindowRect(*h, &mut r);
            let area = (r.right - r.left) * (r.bottom - r.top);
            if best.map(|b| area > b.1).unwrap_or(true) {
                best = Some((*h, area));
            }
        }
        if let Some((h, _)) = best {
            if let Some(shot) = capture(h) {
                let p = std::path::Path::new(&out);
                save_bmp(p.parent().and_then(|d| d.to_str()).unwrap_or("."), p.file_name().and_then(|n| n.to_str()).unwrap_or("shot.bmp"), &shot);
                println!("saved {}x{} {}", shot.w, shot.h, class_of(h));
                return true;
            }
        }
    }
    println!("no window");
    true
}

/// 연구용 부가 기능(PX_LIST=<pid>: 그 프로세스의 보이는 창을 나열 · PX_CLOSE_PREVIEW=<pid>: 미리보기 창들에 WM_CLOSE).
fn utility_modes() -> bool {
    if let Ok(v) = std::env::var("PX_LIST") {
        let pid: u32 = v.parse().unwrap_or(0);
        let mut ctx = Ctx { pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            for h in &ctx.list {
                let mut r = RECT::default();
                let _ = GetWindowRect(*h, &mut r);
                let mut title = [0u16; 128];
                let n = GetWindowTextW(*h, &mut title) as usize;
                println!("{} | {} | {}x{} at {},{}", class_of(*h), String::from_utf16_lossy(&title[..n]), r.right - r.left, r.bottom - r.top, r.left, r.top);
            }
        }
        return true;
    }
    if let Ok(v) = std::env::var("PX_CLOSE_ONE") {
        // 그 프로세스의 창 하나(PX_CLASS 가 있으면 그 클래스의 첫 창)에 WM_CLOSE
        let pid: u32 = v.parse().unwrap_or(0);
        let want = std::env::var("PX_CLASS").ok();
        let mut ctx = Ctx { pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            for h in &ctx.list {
                let c = class_of(*h);
                let real = c == "Tauri Window" || c == "Chrome_WidgetWin_1" || c == "MarkletView";
                if real && want.as_ref().map(|w| *w == c).unwrap_or(true) {
                    let _ = PostMessageW(Some(*h), WM_CLOSE, WPARAM(0), LPARAM(0));
                    println!("closed one");
                    break;
                }
            }
        }
        return true;
    }
    if let Ok(v) = std::env::var("PX_CLOSE_WINDOW") {
        // 앱의 진짜 창(클래스 'Tauri Window')에 WM_CLOSE — 사용자가 닫기 버튼을 누른 것과 같다.
        let pid: u32 = v.parse().unwrap_or(0);
        let mut ctx = Ctx { pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            for h in &ctx.list {
                // 클래스 'Tauri Window'(Tauri 판) · 'Chrome_WidgetWin_1'(Electron 판)
                let c = class_of(*h);
                if c == "Tauri Window" || c == "Chrome_WidgetWin_1" || c == "MarkletView" {
                    let _ = PostMessageW(Some(*h), WM_CLOSE, WPARAM(0), LPARAM(0));
                    println!("closed window");
                }
            }
        }
        return true;
    }
    if let Ok(v) = std::env::var("PX_CLOSE_PREVIEW") {
        let pid: u32 = v.parse().unwrap_or(0);
        let mut ctx = Ctx { pid, list: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            for h in &ctx.list {
                if class_of(*h) == "MarkletPreview" {
                    let _ = PostMessageW(Some(*h), WM_CLOSE, WPARAM(0), LPARAM(0));
                    println!("closed preview");
                }
            }
        }
        return true;
    }
    false
}

fn main() {
    if utility_modes() || act_mode() || shot_mode() {
        return;
    }
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        eprintln!("사용: px-probe <글자가장자리수> <제한ms> <exe> [인자...]");
        std::process::exit(2);
    }
    let min_edges: usize = a[1].parse().unwrap_or(1500);
    let limit = Duration::from_millis(a[2].parse().unwrap_or(15000));
    let save = std::env::var("PX_SAVE").ok();
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let t0 = Instant::now();
    let mut child = Command::new(&a[3]).args(&a[4..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("실행 실패");
    let pid = child.id();
    if let Ok(a) = std::env::var("PX_ATTACH") {
        run_attach(a.parse().unwrap_or(0), &mut child, t0, limit, min_edges);
        return;
    }
    if std::env::var_os("PX_SCREEN").is_some() {
        run_screen(&mut child, t0, limit, min_edges);
        return;
    }
    let mut hit: i64 = -1;
    let mut vis: i64 = -1;
    // 최종 화면: 네이티브 미리보기(MarkletPreview)가 아닌 창에서 글이 보이기 시작한 시각
    let mut fin: i64 = -1;
    let mut gaps: u32 = 0; // 첫 글자가 보인 뒤, 보이는 창은 있는데 글자가 있는 창이 하나도 없던 관측 횟수
    let mut after_fin: Option<Instant> = None;
    let mut seen_first: Vec<isize> = Vec::new();
    let mut seen_hit: Vec<isize> = Vec::new();
    'poll: while t0.elapsed() < limit {
        if let Some(t) = after_fin {
            if t.elapsed() > Duration::from_millis(400) {
                break 'poll;
            }
        }
        let mut ctx = Ctx { pid, list: Vec::new() };
        let mut any_text = false;
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Ctx as isize));
            // 미리보기 창이 떠 있으면 사용자 눈에는 그것만 보인다(진짜 창은 그 뒤에 가려 있다). 가려진 창까지 PrintWindow 하면
            // 그 렌더를 우리가 재촉해 측정이 대상을 바꾼다 — 그래서 미리보기가 있는 동안은 그것만 본다.
            let has_preview = std::env::var_os("PX_ALL").is_none() && ctx.list.iter().any(|h| class_of(*h) == "MarkletPreview");
            if has_preview {
                ctx.list.retain(|h| class_of(*h) == "MarkletPreview");
            }
            for h in &ctx.list {
                let mut r = RECT::default();
                if vis < 0 && GetWindowRect(*h, &mut r).is_ok() && r.right - r.left >= 400 && r.bottom - r.top >= 300 {
                    vis = t0.elapsed().as_millis() as i64;
                }
                let Some(shot) = capture(*h) else { continue };
                let now = t0.elapsed().as_millis() as i64;
                let key = h.0 as isize;
                if let Some(dir) = &save {
                    if !seen_first.contains(&key) {
                        seen_first.push(key);
                        save_bmp(dir, &format!("{}-{:x}-first-{}ms.bmp", class_of(*h), key, now), &shot);
                    }
                }
                let e = edges(&shot, 90);
                if e >= min_edges {
                    any_text = true;
                    if hit < 0 {
                        hit = now;
                    }
                    if fin < 0 && class_of(*h) != "MarkletPreview" {
                        fin = now;
                        after_fin = Some(Instant::now());
                    }
                    if let Some(dir) = &save {
                        if !seen_hit.contains(&key) {
                            seen_hit.push(key);
                            save_bmp(dir, &format!("{}-{:x}-hit-{}ms-edges{}-luma{}.bmp", class_of(*h), key, now, e, mean_luma(&shot)), &shot);
                        }
                    }
                }
            }
            if hit >= 0 && !any_text && !ctx.list.is_empty() {
                gaps += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = child.wait();
    println!("{vis} {hit} {fin} {gaps}");
}
