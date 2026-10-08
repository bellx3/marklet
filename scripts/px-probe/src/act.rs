//! 진짜 입력을 창에 넣는다 — `PX_ACT=<pid> PX_SCRIPT="wait:500;click:300,400;drag:10,10,200,10;chord:ctrl+c;clip;shot:a" [PX_OUT=<폴더>]`
//!
//! 좌표는 클라이언트 영역의 물리 px 다. SendInput 이라 창이 앞에 있어야 한다(스레드 입력을 잠깐 붙여 앞으로 가져온다).
//! 동작: wait:ms · click:x,y · rclick:x,y · dblclick:x,y · tripleclick:x,y · move:x,y · drag:x1,y1,x2,y2 · wheel:delta · hwheel:delta
//!       key:이름 · chord:ctrl+shift+키 · type:글 · clip(클립보드 글 출력) · clearclip · title · rect · shot:이름 · esc(Esc)
//! 출력은 줄마다 `이름=값` 이다.
use std::time::Duration;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub struct Target {
    pub hwnd: HWND,
}

fn vk_of(name: &str) -> Option<VIRTUAL_KEY> {
    let n = name.to_ascii_lowercase();
    Some(match n.as_str() {
        "ctrl" | "control" => VK_CONTROL,
        "shift" => VK_SHIFT,
        "alt" => VK_MENU,
        "enter" | "return" => VK_RETURN,
        "esc" | "escape" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "pgup" | "pageup" => VK_PRIOR,
        "pgdn" | "pagedown" => VK_NEXT,
        "home" => VK_HOME,
        "end" => VK_END,
        "f3" => VK_F3,
        "f11" => VK_F11,
        "plus" | "=" => VK_OEM_PLUS,
        "minus" | "-" => VK_OEM_MINUS,
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap();
            if c.is_ascii_alphabetic() {
                VIRTUAL_KEY(c.to_ascii_uppercase() as u16)
            } else if c.is_ascii_digit() {
                VIRTUAL_KEY(c as u16)
            } else {
                return None;
            }
        }
        _ => return None,
    })
}

unsafe fn send_key(vk: VIRTUAL_KEY, up: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    // 확장 키(방향 · Home · End · PgUp/Dn)
    if matches!(
        vk,
        VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_HOME | VK_END | VK_PRIOR | VK_NEXT
    ) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
}

unsafe fn send_unicode(unit: u16) {
    for up in [false, true] {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

unsafe fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
}

fn nap(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

impl Target {
    unsafe fn to_screen(&self, x: i32, y: i32) -> POINT {
        let mut p = POINT { x, y };
        let _ = ClientToScreen(self.hwnd, &mut p);
        p
    }

    /// 창을 앞으로 가져온다(입력 스레드를 잠깐 붙이는 방법)
    pub unsafe fn focus(&self) {
        let fg = GetForegroundWindow();
        let cur = GetCurrentThreadId();
        let fg_tid = GetWindowThreadProcessId(fg, None);
        let tgt_tid = GetWindowThreadProcessId(self.hwnd, None);
        let _ = AttachThreadInput(cur, fg_tid, true);
        let _ = AttachThreadInput(cur, tgt_tid, true);
        if IsIconic(self.hwnd).as_bool() {
            let _ = ShowWindow(self.hwnd, SW_RESTORE);
        }
        let _ = BringWindowToTop(self.hwnd);
        let _ = SetForegroundWindow(self.hwnd);
        let _ = AttachThreadInput(cur, fg_tid, false);
        let _ = AttachThreadInput(cur, tgt_tid, false);
        nap(150);
        if GetForegroundWindow() != self.hwnd {
            // 포그라운드 잠금: Alt 를 한 번 눌러 풀고 다시 시도한다(Alt 를 눌렀다 떼면 창의 시스템 메뉴 모드가 되므로 Esc 로 나간다)
            send_key(VK_MENU, false);
            send_key(VK_MENU, true);
            let _ = SetForegroundWindow(self.hwnd);
            nap(100);
            send_key(VK_ESCAPE, false);
            send_key(VK_ESCAPE, true);
            nap(100);
        }
    }

    unsafe fn move_to(&self, x: i32, y: i32) {
        let p = self.to_screen(x, y);
        let _ = SetCursorPos(p.x, p.y);
        nap(30);
    }

    unsafe fn click(&self, x: i32, y: i32, right: bool, times: u32) {
        self.move_to(x, y);
        for _ in 0..times {
            mouse(
                if right {
                    MOUSEEVENTF_RIGHTDOWN
                } else {
                    MOUSEEVENTF_LEFTDOWN
                },
                0,
            );
            nap(30);
            mouse(
                if right {
                    MOUSEEVENTF_RIGHTUP
                } else {
                    MOUSEEVENTF_LEFTUP
                },
                0,
            );
            nap(60);
        }
    }

    unsafe fn drag(&self, x1: i32, y1: i32, x2: i32, y2: i32) {
        self.move_to(x1, y1);
        mouse(MOUSEEVENTF_LEFTDOWN, 0);
        nap(60);
        let steps = 12;
        for i in 1..=steps {
            let (x, y) = (x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
            let p = self.to_screen(x, y);
            let _ = SetCursorPos(p.x, p.y);
            nap(20);
        }
        nap(60);
        mouse(MOUSEEVENTF_LEFTUP, 0);
        nap(80);
    }

    unsafe fn chord(&self, spec: &str) {
        let parts: Vec<VIRTUAL_KEY> = spec.split('+').filter_map(vk_of).collect();
        let Some((key, mods)) = parts.split_last() else {
            return;
        };
        for m in mods {
            send_key(*m, false);
        }
        nap(20);
        send_key(*key, false);
        nap(30);
        send_key(*key, true);
        for m in mods.iter().rev() {
            send_key(*m, true);
        }
        nap(120);
    }
}

pub unsafe fn clipboard_text() -> String {
    for _ in 0..10 {
        if OpenClipboard(None).is_ok() {
            let mut out = String::new();
            if let Ok(h) = GetClipboardData(13) {
                let g = HGLOBAL(h.0);
                let p = GlobalLock(g) as *const u16;
                if !p.is_null() {
                    let mut n = 0;
                    while *p.add(n) != 0 {
                        n += 1;
                    }
                    out = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
                    let _ = GlobalUnlock(g);
                }
            }
            let _ = CloseClipboard();
            return out;
        }
        nap(30);
    }
    String::new()
}

pub unsafe fn clear_clipboard() {
    if OpenClipboard(None).is_ok() {
        let _ = EmptyClipboard();
        let _ = CloseClipboard();
    }
}

fn esc(s: &str) -> String {
    s.replace('\n', "\\n").replace('\t', "\\t").replace('\r', "")
}

/// 스크립트를 돌린다. shot 은 (hwnd, 이름) → 저장을 main.rs 가 한다.
pub unsafe fn run(hwnd: HWND, script: &str, shot: &dyn Fn(HWND, &str)) {
    let t = Target { hwnd };
    t.focus();
    for step in script.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let (cmd, arg) = step.split_once(':').unwrap_or((step, ""));
        let nums = |a: &str| -> Vec<i32> {
            a.split(',')
                .filter_map(|v| v.trim().parse().ok())
                .collect()
        };
        match cmd {
            "wait" => nap(arg.parse().unwrap_or(100)),
            "focus" => t.focus(),
            "move" => {
                let n = nums(arg);
                if n.len() == 2 {
                    t.move_to(n[0], n[1]);
                }
            }
            "click" | "rclick" | "dblclick" | "tripleclick" => {
                let n = nums(arg);
                if n.len() == 2 {
                    let times = match cmd {
                        "dblclick" => 2,
                        "tripleclick" => 3,
                        _ => 1,
                    };
                    t.click(n[0], n[1], cmd == "rclick", times);
                }
            }
            "drag" => {
                let n = nums(arg);
                if n.len() == 4 {
                    t.drag(n[0], n[1], n[2], n[3]);
                }
            }
            "wheel" => {
                mouse(MOUSEEVENTF_WHEEL, arg.parse().unwrap_or(-120));
                nap(300);
            }
            "hwheel" => {
                mouse(MOUSEEVENTF_HWHEEL, arg.parse().unwrap_or(120));
                nap(300);
            }
            "key" | "chord" => t.chord(arg),
            "esc" => t.chord("esc"),
            "type" => {
                for u in arg.encode_utf16() {
                    send_unicode(u);
                    nap(15);
                }
                nap(200);
            }
            "clip" => println!("clip={}", esc(&clipboard_text())),
            "clearclip" => clear_clipboard(),
            "title" => {
                let mut b = [0u16; 256];
                let n = GetWindowTextW(hwnd, &mut b) as usize;
                println!("title={}", String::from_utf16_lossy(&b[..n]));
            }
            "rect" => {
                let mut r = RECT::default();
                let _ = GetWindowRect(hwnd, &mut r);
                let mut c = RECT::default();
                let _ = GetClientRect(hwnd, &mut c);
                println!(
                    "rect={},{} {}x{} client={}x{}",
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    c.right,
                    c.bottom
                );
            }
            "alive" => println!("alive={}", IsWindow(Some(hwnd)).as_bool()),
            "shot" => shot(hwnd, arg),
            // 화면(합성 결과)을 창 둘레 포함해 뜬다 — 우클릭 메뉴 · 메뉴 막대의 드롭다운처럼 창 밖에 그려지는 것이 찍힌다
            "sshot" => shot(hwnd, &format!("screen:{arg}")),
            other => println!("unknown={other}"),
        }
    }
}
