//! 문서 안에서 찾기 — src/services/doc-search.ts 와 같은 규칙이다.
//!
//! 규칙 (렌더러와 같다)
//!   · 질의가 초성 자모로만 이뤄지면 초성 모드(본문은 최소 2자), 아니면 대소문자 무시 부분 문자열
//!   · 일치는 500 개에서 멈추고 그 사실을 알린다(`500+`)
//!   · 일치끼리 겹치지 않는다(`....` 에서 `..` 는 둘)
//!   · 변환본의 위치를 원문 위치로 그대로 쓰므로, 변환은 **길이를 지켜야** 한다(터키어 İ 는 소문자로 바꾸면 길이가 달라지니 그대로 둔다)
//!   · 어절을 끊지 않으려고 끼운 U+2060 은 글이 아니다 — 건너뛰고 센다

use super::layout::{Item, Layout};

/// 하이라이트 상한. 넘으면 `500+` 로 표시한다.
pub const MAX_MATCHES: usize = 500;
/// 본문 초성 검색 최소 길이
pub const MIN_CHOSEONG_LEN: usize = 2;

const CHOSEONG: [char; 19] = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ',
    'ㅌ', 'ㅍ', 'ㅎ',
];

/// 한글 음절은 초성 한 글자로, 나머지는 그대로(src/utils/hangul.ts toChoseong)
fn to_choseong_char(c: char) -> char {
    let code = c as u32;
    if (0xac00..=0xd7a3).contains(&code) {
        CHOSEONG[((code - 0xac00) / 588) as usize]
    } else {
        c
    }
}

fn is_choseong_query(q: &str) -> bool {
    let t: Vec<char> = q.chars().filter(|c| !c.is_whitespace()).collect();
    !t.is_empty() && t.iter().all(|c| CHOSEONG.contains(c))
}

/// 길이(UTF-16)를 지키는 소문자 변환. 길이가 달라지는 글자는 그대로 둔다.
fn lower_same_length(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) if l.len_utf16() == c.len_utf16() => l,
        _ => c,
    }
}

/// 검색 질의를 정규화한다. (바늘, 초성 모드). 검색할 수 없으면 None.
fn normalize(raw: &str) -> Option<(Vec<char>, bool)> {
    // 질의만 NFC 로 모은다(맥에서 복사한 분해형). 한글 조합은 별도 크레이트 없이 하지 않는다 — 윈도우 입력은 이미 NFC 다.
    let q = raw.trim();
    if q.is_empty() {
        return None;
    }
    if is_choseong_query(q) {
        let t = q.chars().filter(|c| !c.is_whitespace()).count();
        if t < MIN_CHOSEONG_LEN {
            return None;
        }
        // 공백은 지우지 않는다(본문 오프셋과 어긋난다)
        return Some((q.chars().map(lower_same_length).collect(), true));
    }
    Some((q.chars().map(lower_same_length).collect(), false))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    /// 읽는 순서 번호(글)
    pub ord: u32,
    /// 그 글 안의 UTF-16 위치 [start, end)
    pub start: u32,
    pub end: u32,
}

#[derive(Default)]
pub struct Find {
    pub query: String,
    pub matches: Vec<Match>,
    pub truncated: bool,
    /// 지금 보고 있는 일치(없으면 None)
    pub current: Option<usize>,
}

impl Find {
    pub fn clear(&mut self) {
        self.matches.clear();
        self.truncated = false;
        self.current = None;
    }

    /// 바 오른쪽에 적는 글 — `3/12`, 없으면 `0/0`, 상한이면 `3/500+`
    pub fn label(&self) -> String {
        match self.current {
            None => "0/0".to_string(),
            Some(i) => {
                let total = if self.truncated {
                    format!("{MAX_MATCHES}+")
                } else {
                    self.matches.len().to_string()
                };
                format!("{}/{}", i + 1, total)
            }
        }
    }

    /// 다음(1) · 이전(-1). 끝에서 처음으로 돈다.
    pub fn step(&mut self, dir: i32) {
        let n = self.matches.len();
        if n == 0 {
            return;
        }
        let cur = self.current.unwrap_or(0) as i64;
        self.current = Some(((cur + dir as i64).rem_euclid(n as i64)) as usize);
    }

    /// 이 글(ord)에 걸린 일치들
    pub fn in_text(&self, ord: u32) -> &[Match] {
        let a = self.matches.partition_point(|m| m.ord < ord);
        let b = self.matches.partition_point(|m| m.ord <= ord);
        &self.matches[a..b]
    }

    /// 문서 전체(모두 놓인 레이아웃)에서 query 를 찾는다. 앞에서부터 센다.
    pub fn run(&mut self, layout: &Layout, query: &str) {
        self.query = query.to_string();
        self.clear();
        let Some((needle, choseong)) = normalize(query) else {
            return;
        };
        let n_len = needle.len();
        'all: for item in &layout.items {
            let Item::Text {
                meta: Some(meta), ..
            } = item
            else {
                continue;
            };
            // U+2060 을 뺀 글자들과 그 UTF-16 시작 위치
            let mut chars: Vec<char> = Vec::with_capacity(meta.text.len());
            let mut at: Vec<u32> = Vec::with_capacity(meta.text.len() + 1);
            let mut end_at: Vec<u32> = Vec::with_capacity(meta.text.len() + 1);
            let mut pos = 0u32;
            for r in char::decode_utf16(meta.text.iter().copied()) {
                let c = r.unwrap_or('\u{fffd}');
                let w = c.len_utf16() as u32;
                if c != '\u{2060}' {
                    chars.push(if choseong {
                        to_choseong_char(c)
                    } else {
                        lower_same_length(c)
                    });
                    at.push(pos);
                    end_at.push(pos + w);
                }
                pos += w;
            }
            if chars.len() < n_len {
                continue;
            }
            let mut i = 0;
            while i + n_len <= chars.len() {
                if chars[i..i + n_len] == needle[..] {
                    self.matches.push(Match {
                        ord: meta.ord,
                        start: at[i],
                        // 끝은 마지막 글자의 끝이다(그 뒤에 끼운 U+2060 은 일치가 아니다)
                        end: end_at[i + n_len - 1],
                    });
                    if self.matches.len() >= MAX_MATCHES {
                        self.truncated = true;
                        break 'all;
                    }
                    // 겹치지 않게 일치 길이만큼 건너뛴다
                    i += n_len;
                } else {
                    i += 1;
                }
            }
        }
        if !self.matches.is_empty() {
            self.current = Some(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::layout::tests::{harness, lay};
    use super::*;

    fn found(src: &str, q: &str) -> Find {
        let g = harness().expect("harness");
        let l = lay(&g, src, None);
        let mut f = Find::default();
        f.run(&l, q);
        f
    }

    #[test]
    fn plain_substring_is_case_insensitive_and_non_overlapping() {
        if harness().is_none() {
            return;
        }
        let f = found("Hello hello HELLO\n\n.... 끝\n", "hello");
        assert_eq!(f.matches.len(), 3);
        assert_eq!(f.label(), "1/3");
        let dots = found("....\n", "..");
        assert_eq!(dots.matches.len(), 2);
    }

    #[test]
    fn choseong_needs_two_letters_and_matches_syllables() {
        if harness().is_none() {
            return;
        }
        let f = found("마크다운 뷰어 문서\n", "ㅁㅋ");
        assert_eq!(f.matches.len(), 1);
        // 한글 낱말 안에는 줄바꿈을 막는 U+2060 이 끼어 있어 두 글자가 세 칸이다
        assert_eq!((f.matches[0].start, f.matches[0].end), (0, 3));
        // 한 글자 초성은 오탐이 폭증하므로 찾지 않는다
        assert!(found("마크다운\n", "ㅁ").matches.is_empty());
        // 초성이 아닌 한글은 글자 그대로
        assert_eq!(found("마크다운 마크\n", "마크").matches.len(), 2);
    }

    #[test]
    fn word_joiners_inside_hangul_words_are_skipped() {
        if harness().is_none() {
            return;
        }
        // 한글 어절에는 줄바꿈을 막으려고 U+2060 이 끼어 있다 — 찾기는 그것을 모른다
        let f = found("검색어는 마크다운입니다\n", "마크다운");
        assert_eq!(f.matches.len(), 1);
        let g = harness().unwrap();
        let l = lay(&g, "검색어는 마크다운입니다\n", None);
        let Item::Text { meta: Some(m), .. } = &l.items[0] else {
            panic!()
        };
        let m0 = f.matches[0];
        let txt = String::from_utf16_lossy(&m.text[m0.start as usize..m0.end as usize]);
        // 구간 안에는 U+2060 이 끼어 있어도 글자는 마크다운이다
        assert_eq!(txt.replace('\u{2060}', ""), "마크다운");
    }

    #[test]
    fn matches_stop_at_the_limit_and_say_so() {
        if harness().is_none() {
            return;
        }
        let src = "a ".repeat(MAX_MATCHES + 50) + "\n";
        let f = found(&src, "a");
        assert_eq!(f.matches.len(), MAX_MATCHES);
        assert!(f.truncated);
        assert_eq!(f.label(), format!("1/{MAX_MATCHES}+"));
    }

    #[test]
    fn stepping_wraps_around() {
        let mut f = Find {
            matches: vec![
                Match {
                    ord: 0,
                    start: 0,
                    end: 1,
                },
                Match {
                    ord: 1,
                    start: 0,
                    end: 1,
                },
            ],
            current: Some(1),
            ..Find::default()
        };
        f.step(1);
        assert_eq!(f.current, Some(0));
        f.step(-1);
        assert_eq!(f.current, Some(1));
        assert_eq!(f.in_text(1).len(), 1);
        assert_eq!(f.in_text(5).len(), 0);
    }

    #[test]
    fn length_changing_lowercase_is_left_alone() {
        // 터키어 İ 는 소문자로 바꾸면 두 글자가 된다 — 그대로 두어 위치가 어긋나지 않는다
        assert_eq!(lower_same_length('İ'), 'İ');
        assert_eq!(lower_same_length('A'), 'a');
        assert_eq!(lower_same_length('가'), '가');
    }
}
