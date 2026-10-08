import { describe, it, expect } from 'vitest';
import { localImageUrl } from './local-image';

/** 주소에서 경로만 꺼낸다(메인이 받는 모습: 퍼센트를 한 번 푼 것). */
const dec = (u: string | null) =>
    u ? decodeURIComponent(u.replace('marklet-local://f/', '')) : null;

describe('상대 경로 그림 주소', () => {
    const dir = 'C:\\Users\\a\\docs';

    it('문서 폴더 기준으로 푼다', () => {
        expect(dec(localImageUrl('img/a.png', dir))).toBe('C:/Users/a/docs/img/a.png');
        expect(dec(localImageUrl('./a.png', dir))).toBe('C:/Users/a/docs/a.png');
        expect(dec(localImageUrl('img\\a.png', dir))).toBe('C:/Users/a/docs/img/a.png');
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

    it('앵커 · 쿼리는 뗀다', () => {
        expect(dec(localImageUrl('a.png?raw=1', dir))).toBe('C:/Users/a/docs/a.png');
        expect(dec(localImageUrl('a.png#x', dir))).toBe('C:/Users/a/docs/a.png');
    });

    it('폴더 이름에 # ? % 가 있어도 그 폴더를 가리킨다', () => {
        expect(dec(localImageUrl('a.png', 'C:\\docs\\a#b'))).toBe('C:/docs/a#b/a.png');
        expect(dec(localImageUrl('a.png', 'C:\\docs\\what?'))).toBe('C:/docs/what?/a.png');
        expect(dec(localImageUrl('a.png', 'C:\\docs\\100%'))).toBe('C:/docs/100%/a.png');
        expect(dec(localImageUrl('a.png', 'C:\\docs\\100%25'))).toBe('C:/docs/100%25/a.png');
    });

    it('드라이브 루트의 문서도 된다', () => {
        expect(dec(localImageUrl('a.png', 'C:\\'))).toBe('C:/a.png');
    });

    it('★ 원격 · data · 절대 경로는 건드리지 않는다', () => {
        for (const s of [
            'https://x/a.png',
            'data:image/png;base64,AAAA',
            '/a.png',
            '//h/a.png',
            '\\a.png',
            '\\\\h\\s\\a.png',
            '/\\h/s/a.png',
            'marklet-local://f/C%3A%2Fx.png',
            'file:///C:/x.png',
            'C:\\x.png',
        ]) {
            expect(localImageUrl(s, dir), s).toBeNull();
        }
    });

    it('★ 퍼센트로 숨긴 구분자 · 잘못된 조각은 거절한다', () => {
        for (const s of [
            '%2F%2Fevil%2Fshare%2Fa.png',
            '%5C%5Cevil%5Cshare%5Ca.png',
            '%2Fa.png',
            '%E0%A4%A.png',
            'sub/C:/x.png',
            'a.png:zone',
        ]) {
            expect(localImageUrl(s, dir), s).toBeNull();
        }
    });

    it('빈 값이면 아무것도 하지 않는다', () => {
        expect(localImageUrl('', dir)).toBeNull();
        expect(localImageUrl('   ', dir)).toBeNull();
        expect(localImageUrl('a.png', '')).toBeNull();
    });

    it('절대 경로가 아닌 문서 폴더는 풀지 않는다', () => {
        for (const d of ['docs', '.\\docs', 'C:docs', '\\docs', '\\\\srv', '\\\\srv\\']) {
            expect(localImageUrl('a.png', d), d).toBeNull();
        }
    });

    it('.. 는 드라이브 위로 못 간다', () => {
        expect(dec(localImageUrl('../../../../../a.png', dir))).toBe('C:/a.png');
        expect(dec(localImageUrl('%2e%2e/%2E%2E/%2e%2e/%2e%2e/a.png', dir))).toBe('C:/a.png');
    });

    it('만든 주소에는 날것의 구분자가 없다(경로 전체가 한 조각으로 인코딩된다)', () => {
        const u = localImageUrl('a b/c.png', dir) as string;
        expect(u.startsWith('marklet-local://f/')).toBe(true);
        expect(u.slice('marklet-local://f/'.length)).not.toMatch(/[\\/ ]/);
    });
});

describe('네트워크 공유(UNC)에 있는 문서의 그림', () => {
    const dir = '\\\\srv\\share\\docs';

    it('공유 폴더 기준으로 풀고 앞의 두 슬래시를 지킨다', () => {
        expect(dec(localImageUrl('a.png', dir))).toBe('//srv/share/docs/a.png');
        expect(dec(localImageUrl('img/a.png', dir))).toBe('//srv/share/docs/img/a.png');
        expect(dec(localImageUrl('../x/a.png', dir))).toBe('//srv/share/x/a.png');
    });

    it('슬래시로 쓴 문서 폴더도 같다', () => {
        expect(dec(localImageUrl('a.png', '//srv/share/docs'))).toBe('//srv/share/docs/a.png');
    });

    it('공유 루트의 문서도 된다', () => {
        expect(dec(localImageUrl('a.png', '\\\\srv\\share'))).toBe('//srv/share/a.png');
        expect(dec(localImageUrl('a.png', '\\\\srv\\share\\'))).toBe('//srv/share/a.png');
    });

    it('한글 서버 · 공유 · 폴더 이름과 $ 가 든 관리 공유', () => {
        expect(dec(localImageUrl('그림/내 사진.png', '\\\\NAS\\공유\\문서'))).toBe(
            '//NAS/공유/문서/그림/내 사진.png',
        );
        expect(dec(localImageUrl('a.png', '\\\\localhost\\C$\\Users\\a'))).toBe(
            '//localhost/C$/Users/a/a.png',
        );
    });

    it('긴 경로 꼴(\\\\?\\)은 같은 것으로 본다', () => {
        expect(dec(localImageUrl('a.png', '\\\\?\\UNC\\srv\\share\\docs'))).toBe(
            '//srv/share/docs/a.png',
        );
        expect(dec(localImageUrl('a.png', '\\\\?\\C:\\Users\\a'))).toBe('C:/Users/a/a.png');
    });

    it('★ .. 로 공유 밖으로 못 나간다', () => {
        expect(dec(localImageUrl('../../../../a.png', dir))).toBe('//srv/share/a.png');
        expect(dec(localImageUrl('%2e%2e/%2e%2e/%2e%2e/a.png', dir))).toBe('//srv/share/a.png');
    });

    it('★ 다른 서버를 가리키는 주소는 만들지 않는다', () => {
        for (const s of [
            '//evil/share/a.png',
            '\\\\evil\\share\\a.png',
            '/\\evil/share/a.png',
            '\\evil\\share\\a.png',
            '%2F%2Fevil%2Fshare%2Fa.png',
            '%5C%5Cevil%5Cshare%5Ca.png',
            'http://evil/share/a.png',
            'file://evil/share/a.png',
        ]) {
            expect(localImageUrl(s, dir), s).toBeNull();
        }
    });

    it('드라이브 문서가 네트워크 경로로 새지 않는다', () => {
        for (const s of ['..\\..\\..\\..\\srv\\share\\a.png', '../../../../srv/share/a.png']) {
            expect(dec(localImageUrl(s, 'C:\\docs')), s).toMatch(/^C:\/(srv\/share\/)?a\.png$/);
        }
    });
});
