import { describe, it, expect } from 'vitest';
import { localImageUrl } from './local-image';

describe('상대 경로 그림 주소', () => {
    const dir = 'C:\\Users\\a\\docs';
    const dec = (u: string | null) =>
        u ? decodeURIComponent(u.replace('marklet-local://f/', '')) : null;

    it('문서 폴더 기준으로 푼다', () => {
        expect(dec(localImageUrl('img/a.png', dir))).toBe('C:/Users/a/docs/img/a.png');
        expect(dec(localImageUrl('./a.png', dir))).toBe('C:/Users/a/docs/a.png');
    });

    it('.. 로 위 폴더도 간다', () => {
        expect(dec(localImageUrl('../assets/a.png', dir))).toBe('C:/Users/a/assets/a.png');
    });

    it('한글 · 공백이 든 이름도 풀린다', () => {
        expect(dec(localImageUrl('그림/내 사진.png', dir))).toBe(
            'C:/Users/a/docs/그림/내 사진.png',
        );
        expect(dec(localImageUrl('%EA%B7%B8%EB%A6%BC/a%20b.png', dir))).toBe(
            'C:/Users/a/docs/그림/a b.png',
        );
    });

    it('★ 원격 · data · 절대 경로는 건드리지 않는다', () => {
        for (const s of ['https://x/a.png', 'data:image/png;base64,AAAA', '/a.png', '//h/a.png']) {
            expect(localImageUrl(s, dir), s).toBeNull();
        }
    });

    it('빈 값이면 아무것도 하지 않는다', () => {
        expect(localImageUrl('', dir)).toBeNull();
        expect(localImageUrl('a.png', '')).toBeNull();
    });
});
