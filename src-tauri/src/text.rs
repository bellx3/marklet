//! 파일 바이트 ↔ 글자.
//!
//! ★ 읽기와 쓰기가 짝이다. **열린 그대로 저장돼야** 한다 — 인코딩 · BOM · 줄바꿈을 바꿔 쓰면
//!   사용자는 한 글자도 안 고쳤는데 파일이 통째로 달라진다.

use encoding_rs::{EUC_KR, UTF_16BE, UTF_16LE};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Enc {
    Utf8,
    Utf16Le,
    Utf16Be,
    EucKr,
}

impl Enc {
    /// 렌더러가 아는 이름(DesktopDoc.encoding).
    pub fn name(self) -> &'static str {
        match self {
            Enc::Utf8 => "UTF-8",
            Enc::Utf16Le => "UTF-16LE",
            Enc::Utf16Be => "UTF-16BE",
            Enc::EucKr => "EUC-KR",
        }
    }
}

pub struct Decoded {
    pub text: String,
    pub enc: Enc,
    /// UTF-8 BOM 이 있었는가. (UTF-16 은 BOM 이 형식의 일부라 항상 쓴다.)
    pub bom: bool,
}

/// 바이트 → 글자.
///
/// UTF-16 BOM 을 먼저 보고, 아니면 UTF-8 로 **엄격하게** 읽고, 깨지면 EUC-KR(CP949)로 다시 읽는다.
/// 한국어 윈도우 메모장이 저장한 옛 .txt · .md 가 많다. 관대하게 읽으면 CP949 파일이 조용히 깨져 열린다.
pub fn decode_text(buf: &[u8]) -> Decoded {
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
        let (t, _) = UTF_16LE.decode_without_bom_handling(&buf[2..]);
        return Decoded {
            text: t.into_owned(),
            enc: Enc::Utf16Le,
            bom: true,
        };
    }
    if buf.len() >= 2 && buf[0] == 0xFE && buf[1] == 0xFF {
        let (t, _) = UTF_16BE.decode_without_bom_handling(&buf[2..]);
        return Decoded {
            text: t.into_owned(),
            enc: Enc::Utf16Be,
            bom: true,
        };
    }
    match std::str::from_utf8(buf) {
        Ok(s) => {
            // BOM 은 글자가 아니다. 남기면 첫 줄의 제목 표시가 제목으로 안 읽힌다.
            let (s, bom) = match s.strip_prefix('\u{feff}') {
                Some(rest) => (rest, true),
                None => (s, false),
            };
            Decoded {
                text: s.to_owned(),
                enc: Enc::Utf8,
                bom,
            }
        }
        Err(_) => {
            let (t, _) = EUC_KR.decode_without_bom_handling(buf);
            Decoded {
                text: t.into_owned(),
                enc: Enc::EucKr,
                bom: false,
            }
        }
    }
}

/// 글자 → 바이트. 읽을 때의 인코딩으로 되돌려 쓴다.
/// EUC-KR 로 표현 못 하는 글자(이모지 등)가 있으면 None — 부르는 쪽이 UTF-8 로 바꿀지 묻는다.
pub fn encode_text(text: &str, enc: Enc, bom: bool) -> Option<Vec<u8>> {
    match enc {
        Enc::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            out.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
            Some(out)
        }
        Enc::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            out.extend(text.encode_utf16().flat_map(|u| u.to_be_bytes()));
            Some(out)
        }
        Enc::EucKr => {
            // encoding_rs 는 못 담는 글자를 &#NNNN; 로 바꿔 쓰고 알려 준다. 몰래 바꿔 쓰지 않고 거절한다.
            let (bytes, _, unmappable) = EUC_KR.encode(text);
            if unmappable {
                None
            } else {
                Some(bytes.into_owned())
            }
        }
        Enc::Utf8 => {
            let mut out = Vec::with_capacity(text.len() + 3);
            if bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
            Some(out)
        }
    }
}

/// 줄바꿈 방식. 섞여 있으면 많은 쪽을 따른다.
pub fn detect_eol(text: &str) -> &'static str {
    let b = text.as_bytes();
    let (mut crlf, mut lf) = (0usize, 0usize);
    for (i, &c) in b.iter().enumerate() {
        if c == b'\n' {
            if i > 0 && b[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > 0 && crlf >= lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// 화면의 글자(LF)를 파일의 줄바꿈으로 되돌린다.
pub fn apply_eol(text: &str, eol: &str) -> String {
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    if eol == "\r\n" {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

/// 이 앱이 문서로 여는 확장자. .txt 는 서식 없이 글자 그대로 보여 준다.
pub const DOC_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

/// 문서가 참조하는 그림으로 허용하는 확장자. SVG 는 <img> 로만 쓰이므로 스크립트가 돌지 않는다.
pub const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
];

/// 확장자가 목록에 있는가(대소문자 무시).
pub fn has_ext(path: &std::path::Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_plain_and_bom() {
        let d = decode_text("안녕 # 제목".as_bytes());
        assert_eq!(
            (d.text.as_str(), d.enc, d.bom),
            ("안녕 # 제목", Enc::Utf8, false)
        );

        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("# 제목".as_bytes());
        let d = decode_text(&with_bom);
        // ★ BOM 은 글자로 남지 않고, 있었다는 사실만 기억한다.
        assert_eq!((d.text.as_str(), d.enc, d.bom), ("# 제목", Enc::Utf8, true));
        assert_eq!(encode_text(&d.text, d.enc, d.bom).unwrap(), with_bom);
    }

    #[test]
    fn utf16_both_endians_round_trip() {
        for (enc, bom) in [(Enc::Utf16Le, [0xFF, 0xFE]), (Enc::Utf16Be, [0xFE, 0xFF])] {
            let bytes = encode_text("한글 abc\n둘째 줄", enc, false).unwrap();
            assert_eq!(&bytes[..2], &bom);
            let d = decode_text(&bytes);
            assert_eq!(
                (d.text.as_str(), d.enc, d.bom),
                ("한글 abc\n둘째 줄", enc, true)
            );
            assert_eq!(encode_text(&d.text, d.enc, d.bom).unwrap(), bytes);
        }
    }

    #[test]
    fn cp949_is_decoded_not_garbled_and_written_back_identically() {
        // "한글 테스트" 를 EUC-KR(CP949)로. UTF-8 로는 유효하지 않으므로 폴백 경로를 탄다.
        let (bytes, _, bad) = EUC_KR.encode("한글 테스트 ㅋ 뷁");
        assert!(!bad);
        let d = decode_text(&bytes);
        assert_eq!((d.text.as_str(), d.enc), ("한글 테스트 ㅋ 뷁", Enc::EucKr));
        // 열린 그대로 되돌려 쓴다(확장 완성형 '뷁' 포함).
        assert_eq!(
            encode_text(&d.text, d.enc, d.bom).unwrap(),
            bytes.into_owned()
        );
    }

    #[test]
    fn euckr_refuses_what_it_cannot_hold_instead_of_silently_corrupting() {
        assert!(encode_text("이모지 😀", Enc::EucKr, false).is_none());
        assert!(encode_text("이모지 😀", Enc::Utf8, false).is_some());
    }

    #[test]
    fn eol_detect_and_apply() {
        assert_eq!(detect_eol("a\nb\nc"), "\n");
        assert_eq!(detect_eol("a\r\nb\r\nc"), "\r\n");
        // 섞이면 많은 쪽.
        assert_eq!(detect_eol("a\r\nb\nc\nd"), "\n");
        assert_eq!(detect_eol("a\r\nb\r\nc\nd"), "\r\n");
        assert_eq!(detect_eol("한 줄"), "\n");

        assert_eq!(apply_eol("a\nb", "\r\n"), "a\r\nb");
        assert_eq!(apply_eol("a\r\nb\rc", "\n"), "a\nb\nc");
        assert_eq!(apply_eol("a\nb", "\n"), "a\nb");
    }

    #[test]
    fn extension_lists() {
        use std::path::Path;
        assert!(has_ext(Path::new("C:\\a\\b.MD"), &DOC_EXTENSIONS));
        assert!(has_ext(Path::new("x.txt"), &DOC_EXTENSIONS));
        assert!(!has_ext(Path::new("x.exe"), &DOC_EXTENSIONS));
        assert!(!has_ext(Path::new("noext"), &DOC_EXTENSIONS));
        assert!(has_ext(Path::new("p.PNG"), &IMAGE_EXTENSIONS));
        assert!(!has_ext(Path::new("p.html"), &IMAGE_EXTENSIONS));
    }
}
