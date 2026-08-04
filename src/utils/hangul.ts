/**
 * 초성 검색 원시 함수 (8-5절).
 *
 * 경쟁 앱 20개 중 초성 검색을 언급한 앱이 0개다.
 * 적용 범위는 파일 이름과 문서 본문 둘 다다. 본문 검색은 오탐이 늘어서
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

/** '마크다운 뷰어' → 'ㅁㅋㄷㅇ ㅂㅇ' — 한글이 아닌 문자는 그대로 둔다 */
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

/**
 * 파일 이름 검색.
 * - 질의가 초성만으로 이루어져 있으면 초성끼리 비교한다
 * - 아니면 일반 부분 문자열 (대소문자 무시)
 *
 * 파일 이름은 짧아서 1자 질의도 쓸 만하다. 최소 길이 제한을 두지 않는다.
 * 문서 본문 검색은 같은 원시 함수를 쓰되 최소 2자 제한을 건다 — 8-6절.
 */
export function matchesName(name: string, query: string): boolean {
    const q = query.trim();
    if (!q) return true;
    if (isChoseongQuery(q)) {
        return toChoseong(name).replace(/\s+/g, '').includes(q.replace(/\s+/g, ''));
    }
    return name.toLowerCase().includes(q.toLowerCase());
}
