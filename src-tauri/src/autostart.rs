//! 로그인할 때 앱을 미리 켜 두는 항목(`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`).
//!
//! 사용자가 보기 메뉴에서 **켠 때만** 쓴다(기본은 꺼짐). 켜 두면 로그인 직후(기본 20초 뒤) 창 없이 부팅해 숨겨 두고,
//! 문서를 열면 그 창이 부팅 없이 받는다 — 닫은 뒤 잠시 살려 두는 빠른 시작(app.rs)과 같은 길이고, 대기 시간이 없을 뿐이다.
//! 대가는 로그인해 있는 내내 창 없는 프로세스가 남는 것이다(약 320 MB 작업 집합 / 203 MB 개인).
//!
//! ★ 레지스트리는 현재 사용자(HKCU)만 건드린다. 관리자 권한이 필요 없고, 이 항목 하나(`Marklet`)만 쓰고 지운다.
//! ★ 시험은 진짜 Run 키를 건드리지 않는다 — 환경변수 `MARKLET_RUN_KEY` 로 다른 키를 가리킨다.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
};

const DEFAULT_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const NAME: PCWSTR = w!("Marklet");

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn key_path() -> Vec<u16> {
    wide(&std::env::var("MARKLET_RUN_KEY").unwrap_or_else(|_| DEFAULT_KEY.to_string()))
}

/// 로그인할 때 실행할 명령: `"<이 실행 파일>" --background`
pub fn command_line() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!("\"{}\" --background", exe.display()))
}

/// Run 항목이 있는가(가리키는 경로가 이 실행 파일인지는 보지 않는다 — 옛 위치를 가리켜도 '켜져 있다'고 보여야 끌 수 있다).
pub fn is_enabled() -> bool {
    let key = key_path();
    let mut size = 0u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            NAME,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        ) == ERROR_SUCCESS
    }
}

/// Run 항목을 만들거나 지운다. 성공하면 true.
pub fn set_enabled(on: bool) -> bool {
    let key = key_path();
    unsafe {
        let mut h = HKEY::default();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut h,
            None,
        ) != ERROR_SUCCESS
        {
            return false;
        }
        let ok = if on {
            match command_line() {
                Some(cmd) => {
                    let data: Vec<u8> = wide(&cmd).iter().flat_map(|u| u.to_le_bytes()).collect();
                    RegSetValueExW(h, NAME, None, REG_SZ, Some(&data)) == ERROR_SUCCESS
                }
                None => false,
            }
        } else {
            // 없는 것을 지우는 것은 실패가 아니다.
            let r = RegDeleteValueW(h, NAME);
            r == ERROR_SUCCESS || !is_enabled()
        };
        let _ = RegCloseKey(h);
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Registry::RegDeleteKeyW;

    /// 진짜 Run 키가 아니라 임시 키에서만 시험한다.
    #[test]
    fn run_entry_is_created_read_and_removed() {
        let scratch = r"Software\MarkletTest\Run";
        std::env::set_var("MARKLET_RUN_KEY", scratch);
        assert!(!is_enabled());
        assert!(set_enabled(true));
        assert!(is_enabled());
        // 읽어 보면 우리가 쓴 명령이다
        let key = key_path();
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                NAME,
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        assert_eq!(r, ERROR_SUCCESS);
        let got = String::from_utf16_lossy(&buf[..(size as usize / 2).saturating_sub(1)]);
        assert_eq!(got, command_line().unwrap());
        assert!(got.ends_with("--background"));
        // 끄면 사라지고, 한 번 더 꺼도 실패하지 않는다
        assert!(set_enabled(false));
        assert!(!is_enabled());
        assert!(set_enabled(false));
        unsafe {
            let _ = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()));
            let _ = RegDeleteKeyW(HKEY_CURRENT_USER, w!(r"Software\MarkletTest"));
        }
        std::env::remove_var("MARKLET_RUN_KEY");
    }
}
