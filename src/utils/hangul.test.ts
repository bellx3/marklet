import { describe, it, expect } from 'vitest';
import { toChoseong, isChoseongQuery, matchesName } from './hangul';

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

describe('matchesName', () => {
    it('초성 질의는 초성끼리 비교한다', () => {
        expect(matchesName('마크다운 뷰어', 'ㅁㅋ')).toBe(true);
        expect(matchesName('마크다운 뷰어', 'ㅁㅋㄷㅇ')).toBe(true);
        expect(matchesName('마크다운 뷰어', 'ㅂㅇ')).toBe(true);
        expect(matchesName('마크다운 뷰어', 'ㅁㅋㅇ')).toBe(false);
    });

    it('일반 질의는 대소문자를 무시한 부분 문자열이다', () => {
        expect(matchesName('마크다운 뷰어', '마크')).toBe(true);
        expect(matchesName('README.md', 'readme')).toBe(true);
        expect(matchesName('README.md', 'MD')).toBe(true);
        expect(matchesName('README.md', 'xyz')).toBe(false);
    });

    it('★ 파일 이름 검색에는 최소 길이 제한이 없다 (본문 검색과 다른 점)', () => {
        expect(matchesName('마크다운', 'ㅁ')).toBe(true);
    });

    it('빈 질의는 전부 통과시킨다 (목록을 비우지 않는다)', () => {
        expect(matchesName('아무거나', '')).toBe(true);
        expect(matchesName('아무거나', '   ')).toBe(true);
    });

    it('영문·숫자·한글이 섞여도 동작한다', () => {
        expect(matchesName('2026 회의록 v2.md', 'ㅎㅇㄹ')).toBe(true);
        expect(matchesName('2026 회의록 v2.md', '2026')).toBe(true);
        expect(matchesName('2026 회의록 v2.md', 'v2')).toBe(true);
    });
});
