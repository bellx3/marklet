/**
 * 초성 검색 원시 함수 (8-5절).
 *
 * 문서 안 검색(services/doc-search.ts)이 쓴다. 본문 검색은 오탐이 늘어서
 * **최소 2자 제한**을 거는데, 그 처리는 doc-search.ts 가 한다.
 */

const CHOSEONG = [
    'ㄱ',
    'ㄲ',
    'ㄴ',
    'ㄷ',
    'ㄸ',
    'ㄹ',
    'ㅁ',
    'ㅂ',
    'ㅃ',
    'ㅅ',
    'ㅆ',
    'ㅇ',
    'ㅈ',
    'ㅉ',
    'ㅊ',
    'ㅋ',
    'ㅌ',
    'ㅍ',
    'ㅎ',
];

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JAMO_PER_CHO = 588; // 21 중성 × 28 종성

/**
 * '마크다운 뷰어' → 'ㅁㅋㄷㅇ ㅂㅇ' — 한글이 아닌 문자는 그대로 둔다.
 *
 * ★★ **여기서 NFC 정규화를 하지 마라.** 이 함수는 문서 내 검색에서도 쓰이는데,
 *   거기서는 변환본의 인덱스를 원문 인덱스로 그대로 쓴다 —
 *   정규화는 길이를 바꾸므로(분해된 '마' 3자 → 1자) 하이라이트가 어긋난다.
 *   분해된 글자를 다뤄야 하는 쪽이 **부르기 전에** 모아 준다.
 */
export function toChoseong(s: string): string {
    let out = '';
    for (const ch of s) {
        const code = ch.codePointAt(0)!;
        if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
            out += CHOSEONG[Math.floor((code - HANGUL_BASE) / JAMO_PER_CHO)];
        } else {
            out += ch;
        }
    }
    return out;
}

/** 질의가 전부 초성 자모인지. 'ㅁㅋ' → true, '마크' → false */
export function isChoseongQuery(q: string): boolean {
    const t = q.replace(/\s+/g, '');
    return t.length > 0 && [...t].every((c) => CHOSEONG.includes(c));
}
