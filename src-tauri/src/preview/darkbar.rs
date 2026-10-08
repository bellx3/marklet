//! 어두운 메뉴 막대 — Windows 의 메뉴 막대는 테마를 따르지 않고 항상 밝게 그려진다. 어두운 테마에서는 그것만 하얗게 튀므로 직접 칠한다.
//!
//! 메뉴 막대가 그려질 때 창에 오는 문서화되지 않은 메시지(`WM_UAHDRAWMENU` · `WM_UAHDRAWMENUITEM`)를 받아 막대 바탕과 항목을 칠하고,
//! 막대 아래에 남는 1px 밝은 선은 `WM_NCPAINT` · `WM_NCACTIVATE` 뒤에 덮는다(Notepad++ 등이 쓰는 같은 방법). 구조체 모양은 알려진 역공학 값이다.
//! 없는 Windows 에서는 메시지가 안 와서 밝은 막대가 그대로 남을 뿐이다.

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, DeleteObject, DrawTextW, FillRect, GetWindowDC, OffsetRect, ReleaseDC,
    SetBkMode, SetTextColor, DT_CENTER, DT_SINGLELINE, DT_VCENTER, HDC, TRANSPARENT,
};
use windows::Win32::UI::Controls::DRAWITEMSTRUCT;
use windows::Win32::UI::WindowsAndMessaging::*;

pub const WM_UAHDRAWMENU: u32 = 0x0091;
pub const WM_UAHDRAWMENUITEM: u32 = 0x0092;

const ODS_SELECTED: u32 = 0x0001;
const ODS_HOTLIGHT: u32 = 0x0040;

const BAR_BG: u32 = 0x1b1e24; // #1b1e24 (BGR 로는 아래에서 뒤집는다)
const ITEM_HOT: u32 = 0x2c3037;
const ITEM_SEL: u32 = 0x3a404a;
const TEXT: u32 = 0xd6d9de;

fn bgr(rgb: u32) -> COLORREF {
    COLORREF(((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff))
}

#[repr(C)]
struct UahMenu {
    hmenu: HMENU,
    hdc: HDC,
    flags: u32,
}

#[repr(C)]
struct UahDrawMenuItem {
    dis: DRAWITEMSTRUCT,
    um: UahMenu,
    /// UAHMENUITEM 의 첫 필드(그 뒤의 크기 정보는 쓰지 않는다)
    position: i32,
}

/// 막대의 사각형(창 좌표 — 창 왼쪽 위가 원점)
unsafe fn bar_rect(hwnd: HWND) -> Option<RECT> {
    let mut mbi = MENUBARINFO {
        cbSize: std::mem::size_of::<MENUBARINFO>() as u32,
        ..Default::default()
    };
    GetMenuBarInfo(hwnd, OBJID_MENU, 0, &mut mbi).ok()?;
    let mut w = RECT::default();
    GetWindowRect(hwnd, &mut w).ok()?;
    let mut rc = mbi.rcBar;
    let _ = OffsetRect(&mut rc, -w.left, -w.top);
    Some(rc)
}

/// `WM_UAHDRAWMENU`: 막대 바탕
pub unsafe fn draw_bar(hwnd: HWND, lp: LPARAM) -> bool {
    let um = &*(lp.0 as *const UahMenu);
    let Some(rc) = bar_rect(hwnd) else {
        return false;
    };
    let br = CreateSolidBrush(bgr(BAR_BG));
    FillRect(um.hdc, &rc, br);
    let _ = DeleteObject(br.into());
    true
}

/// `WM_UAHDRAWMENUITEM`: 항목 하나(바탕 + 글자)
pub unsafe fn draw_item(lp: LPARAM) -> bool {
    let d = &*(lp.0 as *const UahDrawMenuItem);
    let mut buf = [0u16; 128];
    let mut mii = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_STRING,
        dwTypeData: windows::core::PWSTR(buf.as_mut_ptr()),
        cch: (buf.len() - 1) as u32,
        ..Default::default()
    };
    if GetMenuItemInfoW(d.um.hmenu, d.position as u32, true, &mut mii).is_err() {
        return false;
    }
    let state = d.dis.itemState.0;
    let bg = if state & ODS_SELECTED != 0 {
        ITEM_SEL
    } else if state & ODS_HOTLIGHT != 0 {
        ITEM_HOT
    } else {
        BAR_BG
    };
    let br = CreateSolidBrush(bgr(bg));
    FillRect(d.um.hdc, &d.dis.rcItem, br);
    let _ = DeleteObject(br.into());
    SetBkMode(d.um.hdc, TRANSPARENT);
    SetTextColor(d.um.hdc, bgr(TEXT));
    let n = mii.cch as usize;
    let mut rc = d.dis.rcItem;
    DrawTextW(
        d.um.hdc,
        &mut buf[..n],
        &mut rc,
        DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
    true
}

/// 막대 아래에 Windows 가 남기는 밝은 1px 선을 막대 색으로 덮는다(`WM_NCPAINT` · `WM_NCACTIVATE` 를 기본 처리한 뒤에 부른다)
pub unsafe fn cover_bottom_line(hwnd: HWND) {
    let Some(bar) = bar_rect(hwnd) else { return };
    let mut client = RECT::default();
    if GetClientRect(hwnd, &mut client).is_err() {
        return;
    }
    let mut pts = [POINT {
        x: client.left,
        y: client.top,
    }];
    // 클라이언트 → 화면 → 창 좌표
    let _ = windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut pts[0]);
    let mut w = RECT::default();
    if GetWindowRect(hwnd, &mut w).is_err() {
        return;
    }
    let top = pts[0].y - w.top;
    let line = RECT {
        left: bar.left,
        top: top - 1,
        right: bar.right,
        bottom: top,
    };
    let hdc = GetWindowDC(Some(hwnd));
    let br = CreateSolidBrush(bgr(BAR_BG));
    FillRect(hdc, &line, br);
    let _ = DeleteObject(br.into());
    ReleaseDC(Some(hwnd), hdc);
}
