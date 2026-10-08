import { describe, it, expect } from 'vitest';
import { toChoseong, isChoseongQuery } from './hangul';

/** 11-2절 #19 — 차별점 기능(초성 검색)의 회귀 방지. */

describe('toChoseong', () => {
    it('한글 음절을 초성으로 바꾸고 나머지는 그대로 둔다', () => {
        expect(toChoseong('마크다운 뷰어')).toBe('ㅁㅋㄷㅇ ㅂㅇ');
        expect(toChoseong('Marklet 1.0')).toBe('Marklet 1.0');
        expect(toChoseong('회의록2026')).toBe('ㅎㅇㄹ2026');
    });

    it('★ 음절 1자 = 초성 1자라 문자 오프셋이 보존된다 (doc-search 하이라이트의 전제)', () => {
        const s = '가나다 라마바';
        expect(toChoseong(s).length).toBe(s.length);
        expect(toChoseong(s).indexOf('ㄹ')).toBe(s.indexOf('라'));
    });

    it('쌍자음 초성도 처리한다', () => {
        expect(toChoseong('까치')).toBe('ㄲㅊ');
        expect(toChoseong('땅')).toBe('ㄸ');
    });
});

describe('isChoseongQuery', () => {
    it.each(['ㅁㅋ', 'ㅁㅋㄷㅇ', 'ㄲㅊ', 'ㅁ ㅋ'])('초성 질의: %s', (q) => {
        expect(isChoseongQuery(q)).toBe(true);
    });
    it.each(['마크', 'md', '', ' ', 'ㅁ크', 'ㅏㅑ'])('초성 질의가 아니다: %s', (q) => {
        expect(isChoseongQuery(q)).toBe(false);
    });
});

/**
 * ★ toChoseong 은 길이를 바꾸지 않는다. 문서 내 검색(services/doc-search.ts)이 이 함수의 결과 인덱스를
 *   **원문 인덱스로 그대로** 쓰기 때문에, 여기서 정규화하면 길이가 바뀌어 하이라이트가 어긋난다.
 *   (맥에서 온 이름처럼 자모가 분해된 NFD 글도 마찬가지다 — 정규화는 부르는 쪽의 몫이다.)
 */
describe('toChoseong 의 길이', () => {
    const NFC = '마크다운 뷰어.md';
    const NFD = NFC.normalize('NFD');

    it('전제 확인 — 눈에는 같지만 문자열은 다르다', () => {
        expect(NFD).not.toBe(NFC);
        expect(NFD.length).toBeGreaterThan(NFC.length);
    });

    it('★ toChoseong 은 길이를 바꾸지 않는다 (문서 내 검색의 전제)', () => {
        for (const s of [NFC, NFD, 'İstanbul 마크다운', '가나다 abc 123 😀']) {
            expect(toChoseong(s).length, `길이가 바뀌었다: ${s}`).toBe(s.length);
        }
    });
});
