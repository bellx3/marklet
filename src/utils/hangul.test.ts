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

/**
 * ★★★ 2026-08-06. **맥에서 온 파일은 이름으로 찾을 수 없었다.**
 *
 *   맥이 만든 파일 이름은 자모가 분해된 채(NFD) 온다 — 아이클라우드·드롭박스·
 *   구글 드라이브·USB 어느 경로로 와도 그렇다. 화면에는 '마크다운.md' 로 똑같이
 *   보이지만 문자열은 ㅁ+ㅏ+ㅋ+ㅡ… 아홉 글자다(실측: NFC 4자 ↔ NFD 9자).
 *
 *   그래서 이 앱이 내세우는 초성 검색이 그런 파일에는 **아예 안 들었다.**
 *   초성뿐 아니라 '마크' 로 찾아도 안 나왔다 — 부분 문자열도 안 맞기 때문이다.
 *   목록에는 보이는데 이름으로는 못 찾는다. 앱이 고장난 것으로 읽힌다.
 */
describe('★★ 분해된 한글(NFD) 이름도 찾는다 — 맥에서 온 파일', () => {
    const NFC = '마크다운 뷰어.md';
    const NFD = NFC.normalize('NFD');

    it('전제 확인 — 눈에는 같지만 문자열은 다르다', () => {
        expect(NFD).not.toBe(NFC);
        expect(NFD.length).toBeGreaterThan(NFC.length);
    });

    it.each([
        ['초성', 'ㅁㅋ'],
        ['초성 두 낱말', 'ㅁㅋㄷㅇ'],
        ['보통 글자', '마크'],
        ['낱말 전체', '마크다운'],
    ])('★ NFD 이름을 %s 로 찾는다', (_이름, 질의) => {
        expect(matchesName(NFD, 질의), 'NFD 이름을 못 찾는다').toBe(true);
        expect(matchesName(NFC, 질의), 'NFC 이름을 못 찾는다').toBe(true);
    });

    it('★ 질의가 NFD 여도 찾는다 (맥에서 복사해 붙인 검색어)', () => {
        expect(matchesName(NFC, '마크'.normalize('NFD'))).toBe(true);
        expect(matchesName(NFD, '마크'.normalize('NFD'))).toBe(true);
    });

    it('없는 이름은 여전히 안 나온다 (전부 참으로 만들지 않았다)', () => {
        expect(matchesName(NFD, 'ㅈㅅ')).toBe(false);
        expect(matchesName(NFD, '없는말')).toBe(false);
    });

    /*
     * ★ toChoseong 자체는 그대로 둔다. 문서 내 검색이 이 함수의 결과 인덱스를
     *   **원문 인덱스로 그대로** 쓰기 때문에, 여기서 정규화하면 길이가 바뀌어
     *   하이라이트가 어긋난다. 모으는 일은 부르는 쪽(matchesName)의 몫이다.
     */
    it('★ toChoseong 은 길이를 바꾸지 않는다 (문서 내 검색의 전제)', () => {
        for (const s of [NFC, NFD, 'İstanbul 마크다운', '가나다 abc 123 😀']) {
            expect(toChoseong(s).length, `길이가 바뀌었다: ${s}`).toBe(s.length);
        }
    });
});
