//! 문서 안의 상대 링크가 가리키는 파일.
//!
//! 마크다운은 출처를 모르는 입력이다. 링크를 누르면 메인이 그 경로를 연다(stat → read).
//! ★ 그 경로가 **네트워크 경로(UNC)** 가 되면 열기만 해도 윈도우가 그 서버에 SMB 인증을 보낸다(NTLM 해시 유출).
//!   `[x](//evil.example/share/a.md)` 가 경로로 풀리면 `\\evil.example\share\a.md` 가 된다.
//!   그래서 **풀기 전에 글자 꼴을 거르고**, 푼 뒤에도 같은 공유 밖이면 거절한다.
//!
//! 여기서는 `PathBuf::push` 에 날것의 조각을 넣지 않는다 —
//! 윈도우에서 `push("C:foo")` 는 앞 경로를 통째로 바꿔 버리기 때문이다. 조각에 `:` 가 있으면 아예 거절한다.

use std::path::{Component, Path, PathBuf};

/// 스킴(`http:` · `file:` · `C:` …)으로 시작하는가.
fn has_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// decodeURIComponent 와 같다: 잘못된 `%xx` 나 UTF-8 이 아니면 None.
fn percent_decode_strict(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hi = b.get(i + 1).and_then(|c| (*c as char).to_digit(16))?;
            let lo = b.get(i + 2).and_then(|c| (*c as char).to_digit(16))?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// UNC 의 서버·공유 부분(대소문자 무시). UNC 가 아니면 None.
pub fn unc_root(p: &Path) -> Option<String> {
    match p.components().next() {
        Some(Component::Prefix(pre)) => {
            let s = pre.as_os_str().to_string_lossy().to_lowercase();
            // `\\server\share` 또는 `\\?\UNC\server\share`
            if s.starts_with("\\\\") {
                Some(s)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// @param doc_dir 지금 문서가 있는 폴더(절대 경로)
/// @param href    링크의 href 그대로(상대 주소)
/// @return 열어도 되는 절대 경로. 열면 안 되는 것은 None.
pub fn resolve_doc_link(doc_dir: &Path, href: &str) -> Option<PathBuf> {
    if doc_dir.as_os_str().is_empty() {
        return None;
    }
    // 스킴이 있으면 상대 링크가 아니다.
    if has_scheme(href) {
        return None;
    }
    let cut = href.split('#').next().unwrap_or("");
    let cut = cut.split('?').next().unwrap_or("");
    let rel = percent_decode_strict(cut)?;
    if rel.is_empty() {
        return None;
    }

    // 풀기 전에: 네트워크 경로 꼴(`//host` · `\\host` · `/\host` · `\host`)은 상대 링크가 아니다.
    // (디코드한 뒤에 본다 — `%2F%2Fhost` 로 숨겨도 걸린다.)
    let mut it = rel.chars();
    let (c0, c1) = (it.next(), it.next());
    let sep = |c: Option<char>| matches!(c, Some('/') | Some('\\'));
    if (sep(c0) && sep(c1)) || c0 == Some('\\') {
        return None;
    }

    // 기준 폴더를 조각으로 나눈다(접두사 · 루트는 그대로 두고 아래로만 움직인다).
    let mut out = PathBuf::new();
    for c in doc_dir.components() {
        match c {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
        }
    }

    for seg in rel.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                // 루트(드라이브 · 공유) 위로는 못 올라간다. pop 이 false 면 그대로 둔다.
                out.pop();
            }
            s => {
                // 드라이브 문자(`C:`) · 대체 데이터 스트림(`a.md:zone`)이 끼어들 틈을 없앤다.
                if s.contains(':') {
                    return None;
                }
                out.push(s);
            }
        }
    }

    // 푼 뒤에도: 결과가 UNC 이면, 문서 자신이 같은 서버·공유에 있을 때만 허용한다.
    let root = unc_root(&out);
    if root.is_some() && root != unc_root(doc_dir) {
        return None;
    }
    Some(out)
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    fn open(dir: &str, href: &str) -> Option<String> {
        resolve_doc_link(Path::new(dir), href).map(|p| p.to_string_lossy().into_owned())
    }
    const DIR: &str = "C:\\docs\\notes";

    #[test]
    fn normal_links_resolve() {
        assert_eq!(open(DIR, "b.md").as_deref(), Some("C:\\docs\\notes\\b.md"));
        assert_eq!(
            open(DIR, "./sub/c.md").as_deref(),
            Some("C:\\docs\\notes\\sub\\c.md")
        );
        assert_eq!(open(DIR, "../top.md").as_deref(), Some("C:\\docs\\top.md"));
        assert_eq!(
            open(DIR, "sub\\c.md").as_deref(),
            Some("C:\\docs\\notes\\sub\\c.md")
        );
    }

    #[test]
    fn anchors_queries_and_percent_encoding() {
        assert_eq!(
            open(DIR, "b.md#절").as_deref(),
            Some("C:\\docs\\notes\\b.md")
        );
        assert_eq!(
            open(DIR, "b.md?x=1").as_deref(),
            Some("C:\\docs\\notes\\b.md")
        );
        assert_eq!(
            open(DIR, "%ED%95%9C%EA%B8%80.md").as_deref(),
            Some("C:\\docs\\notes\\한글.md")
        );
    }

    #[test]
    fn climbing_cannot_leave_the_root() {
        assert_eq!(open(DIR, "../../../../x.md").as_deref(), Some("C:\\x.md"));
    }

    #[test]
    fn network_paths_are_refused() {
        for href in [
            "//evil.example/share/a.md",
            "\\\\evil.example\\share\\a.md",
            "/\\evil.example/share/a.md",
            "\\/evil.example/share/a.md",
            "\\evil.example\\share\\a.md",
            "%2F%2Fevil.example/share/a.md",
            "%5C%5Cevil.example%5Cshare%5Ca.md",
        ] {
            assert_eq!(open(DIR, href), None, "{href}");
        }
    }

    #[test]
    fn schemes_drives_and_junk_are_refused() {
        for href in [
            "http://example.com/a.md",
            "file:///C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "C:/Windows/win.ini",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "",
            "#only-anchor",
            "%E0%A4%A.md",
            "sub/C:/x.md",
            "a.md:zone",
        ] {
            assert_eq!(open(DIR, href), None, "{href}");
        }
        assert!(resolve_doc_link(Path::new(""), "a.md").is_none());
    }

    #[test]
    fn a_document_on_a_share_may_link_within_that_share_only() {
        let share = "\\\\srv\\share\\docs";
        assert_eq!(
            open(share, "b.md").as_deref(),
            Some("\\\\srv\\share\\docs\\b.md")
        );
        assert_eq!(
            open(share, "../c.md").as_deref(),
            Some("\\\\srv\\share\\c.md")
        );
        assert_eq!(open(share, "//evil.example/share/a.md"), None);
        assert_eq!(open(share, "\\\\evil.example\\share\\a.md"), None);
    }
}
