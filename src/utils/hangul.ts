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

/**
 * '마크다운 뷰어' → 'ㅁㅋㄷㅇ ㅂㅇ' — 한글이 아닌 문자는 그대로 둔다.
 *
 * ★★ **여기서 NFC 정규화를 하지 마라.** 이 함수는 문서 내 검색에서도 쓰이는데,
 *   거기서는 변환본의 인덱스를 원문 인덱스로 그대로 쓴다 —
 *   정규화는 길이를 바꾸므로(분해된 '마' 3자 → 1자) 하이라이트가 어긋난다.
 *   분해된 글자를 다뤄야 하는 쪽(matchesName)이 **부르기 전에** 모아 준다.
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

/**
 * 파일 이름 검색.
 * - 질의가 초성만으로 이루어져 있으면 초성끼리 비교한다
 * - 아니면 일반 부분 문자열 (대소문자 무시)
 *
 * 파일 이름은 짧아서 1자 질의도 쓸 만하다. 최소 길이 제한을 두지 않는다.
 * 문서 본문 검색은 같은 원시 함수를 쓰되 최소 2자 제한을 건다 — 8-6절.
 */
export function matchesName(name: string, query: string): boolean {
    /*
     * ★★★ 자모를 먼저 모은다 (2026-08-06).
     *
     *   **맥에서 만든 파일 이름은 자모가 분해된 채(NFD) 온다.** 아이클라우드·드롭박스·
     *   구글 드라이브·USB 어느 경로로 와도 그렇다. 화면에는 '마크다운.md' 로 똑같이
     *   보이지만 문자열은 ㅁ+ㅏ+ㅋ+ㅡ… 아홉 글자다(실측: NFC 4자 ↔ NFD 9자).
     *
     *   그래서 이 앱이 내세우는 초성 검색이 **그런 파일에는 아예 안 들었다.**
     *       toChoseong('마크다운'(NFD))  →  'ㅁㅋㄷㅇ' 이 아니라 분해된 그대로
     *       matchesName(NFD 이름, 'ㅁㅋ') → false
     *   초성뿐 아니라 **'마크' 로 찾아도 안 나왔다** — 부분 문자열도 안 맞기 때문이다.
     *   목록에는 보이는데 이름으로는 못 찾는다. 앱이 고장난 것으로 읽힌다.
     *
     * ★ 여기서만 모은다. toChoseong 안에서 하면 문서 내 검색의 오프셋이 깨진다(위 주석).
     * ★ 질의도 함께 모은다 — 맥에서 복사해 붙인 검색어가 NFD 일 수 있다.
     */
    const n = name.normalize('NFC');
    const q = query.normalize('NFC').trim();
    if (!q) return true;
    if (isChoseongQuery(q)) {
        return toChoseong(n).replace(/\s+/g, '').includes(q.replace(/\s+/g, ''));
    }
    return n.toLowerCase().includes(q.toLowerCase());
}
