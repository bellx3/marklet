import { describe, it, expect, afterEach, vi } from 'vitest';
import { en } from './en';
import { ko } from './ko';
import { t, setLanguage, resolveLang, getLang, localeTag } from './index';

/**
 * 언어 카탈로그 (10-B절).
 *
 * ★ 키 누락은 타입이 잡는다(`ko: Catalog`). 여기서는 **타입이 못 잡는 것**을 본다 —
 *   ① 값이 비어 있거나 번역을 잊고 한국어를 그대로 둔 경우
 *   ② 파라미터가 결과 문장에 실제로 들어갔는지
 */

const HANGUL = /[가-힣]/;

/** 카탈로그를 'section.key' → 값 으로 펴 준다. */
function flatten(cat: Record<string, Record<string, unknown>>) {
    const out: Array<[string, unknown]> = [];
    for (const [section, entries] of Object.entries(cat)) {
        for (const [key, value] of Object.entries(entries)) out.push([`${section}.${key}`, value]);
    }
    return out;
}

/** 함수형 문자열은 표본 인자를 넣어 결과를 본다. */
function sample(value: unknown): string {
    if (typeof value !== 'function') return String(value);
    // 인자 개수만큼 넣는다. 숫자 자리에 문자열이 들어가도 결과 문자열에는 그대로 찍힌다.
    const args = Array.from({ length: value.length }, (_, i) => `«${i}»`);
    return String((value as (...a: unknown[]) => string)(...args));
}

afterEach(() => setLanguage('en'));

describe('카탈로그 — 두 언어가 같은 모양이다', () => {
    it('키 집합이 정확히 같다', () => {
        expect(flatten(ko).map(([k]) => k)).toEqual(flatten(en).map(([k]) => k));
    });

    it('같은 키는 같은 종류다 (한쪽만 함수면 호출부가 깨진다)', () => {
        const kinds = (c: object) =>
            flatten(c as never).map(([k, v]) => `${k}:${typeof v === 'function' ? 'fn' : 'str'}`);
        expect(kinds(ko)).toEqual(kinds(en));
    });

    it('함수는 인자 개수가 같다', () => {
        for (const [key, value] of flatten(en)) {
            if (typeof value !== 'function') continue;
            const other = flatten(ko).find(([k]) => k === key)?.[1] as () => string;
            expect(`${key}/${other.length}`).toBe(`${key}/${value.length}`);
        }
    });

    it('빈 문자열이 없다', () => {
        for (const cat of [en, ko]) {
            for (const [key, value] of flatten(cat as never)) {
                expect(sample(value).trim(), key).not.toBe('');
            }
        }
    });

    it('★ 영어 카탈로그에 한글이 남아 있지 않다 (번역을 잊은 자리)', () => {
        const left = flatten(en).filter(([, v]) => HANGUL.test(sample(v)));
        expect(left.map(([k]) => k)).toEqual([]);
    });

    it('★ 파라미터가 결과 문장에 실제로 들어간다', () => {
        for (const cat of [en, ko]) {
            for (const [key, value] of flatten(cat as never)) {
                if (typeof value !== 'function' || value.length === 0) continue;
                const out = sample(value);
                for (let i = 0; i < value.length; i++) {
                    expect(out, `${key} 의 인자 ${i}`).toContain(`«${i}»`);
                }
            }
        }
    });
});

describe('언어 결정', () => {
    it('system 은 기기 언어를 따른다', () => {
        expect(resolveLang('ko')).toBe('ko');
        expect(resolveLang('en')).toBe('en');
        // jsdom 기본은 en-US 다.
        expect(resolveLang('system')).toBe('en');
    });

    it('★ ko-KR · ko-Kore-KR 같은 하위 태그도 한국어로 본다', () => {
        for (const tag of ['ko', 'ko-KR', 'ko-Kore-KR', 'KO-kr']) {
            const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue([tag]);
            expect(resolveLang('system'), tag).toBe('ko');
            spy.mockRestore();
        }
    });

    it('아는 언어가 아니면 영어로 떨어진다', () => {
        const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja-JP', 'fr']);
        expect(resolveLang('system')).toBe('en');
        spy.mockRestore();
    });

    it('★ t 는 살아 있는 바인딩이다 — setLanguage 뒤에 값이 바뀐다', () => {
        setLanguage('en');
        expect(t.common.close).toBe(en.common.close);
        setLanguage('ko');
        expect(t.common.close).toBe(ko.common.close);
        expect(getLang()).toBe('ko');
    });

    it('<html lang> 과 정렬 로케일이 함께 바뀐다', () => {
        setLanguage('ko');
        expect(document.documentElement.lang).toBe('ko');
        expect(localeTag()).toBe('ko-KR');
        setLanguage('en');
        expect(document.documentElement.lang).toBe('en');
        expect(localeTag()).toBe('en-US');
    });
});

/**
 * ★★★ 2026-08-06. 두 겹 중 안쪽 방어.
 *
 *   `CATALOGS[모르는 값]` 은 undefined 다. 그러면 `t` 가 통째로 사라지고
 *   첫 `t.어쩌구` 에서 **부팅이 죽는다.** 저장된 설정에 그런 값이 있으면
 *   켤 때마다 같은 자리에서 죽고, 앱 데이터를 지우는 것 말고는 길이 없다.
 *
 *   바깥쪽은 settings.ts 의 sanitize 가 막는다. 여기서 한 번 더 막는 이유는
 *   **그 검사를 지나지 않는 경로가 생길 수 있기 때문**이다 —
 *   설정 화면이 직접 부르거나, 나중에 딥링크 같은 것이 생기거나.
 */
describe('★★ 모르는 언어가 와도 카탈로그가 살아 있다', () => {
    it.each(['fr', 'ja', '', 'KO', 'en-US'])('%s → 영어로 떨어진다', (bad) => {
        expect(resolveLang(bad as never)).toBe('en');
    });

    it('★ setLanguage 에 모르는 값을 줘도 t 가 사라지지 않는다', () => {
        setLanguage('fr' as never);
        expect(t?.common?.close, '카탈로그가 사라졌다 — 여기서 부팅이 죽는다').toBeTruthy();
        expect(getLang()).toBe('en');
    });

    it('아는 값은 그대로 간다 (전부 영어로 밀지 않는다)', () => {
        expect(resolveLang('ko')).toBe('ko');
        expect(resolveLang('en')).toBe('en');
        setLanguage('ko');
        expect(getLang()).toBe('ko');
    });
});

/**
 * navigator.languages 는 **사용자가 매긴 우선순위 목록**이다 (2026-08-07 실기기).
 *
 * ★★★ 예전에는 `tags.some(startsWith('ko'))` 였다 — 목록 어딘가에 한국어가 있기만
 *   하면 한국어를 골랐다. 안드로이드 13+ 의 '앱별 언어' 로 마크릿만 영어로 지정하면
 *       navigator.languages = ['en-US', 'ko-KR']
 *   가 되는데 화면이 **한국어로 떴다.** 사용자가 이 앱만 콕 집어 영어로 바꿨는데
 *   그 지정이 통째로 무시된 것이다.
 */
describe('★★ 시스템 언어는 순서를 지킨다', () => {
    const 목록으로 = (tags: string[]): string => {
        const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags);
        try {
            return resolveLang('system');
        } finally {
            spy.mockRestore();
        }
    };

    it('★★ 영어가 1순위면 목록에 한국어가 있어도 영어다', () => {
        expect(목록으로(['en-US', 'ko-KR']), '앱별 언어 지정이 무시된다').toBe('en');
    });

    it('한국어가 1순위면 한국어다', () => {
        expect(목록으로(['ko-KR', 'en-US'])).toBe('ko');
    });

    it('모르는 언어는 건너뛰고 다음 순위를 본다', () => {
        expect(목록으로(['ja-JP', 'ko-KR', 'en-US'])).toBe('ko');
        expect(목록으로(['fr-FR', 'en-GB', 'ko-KR'])).toBe('en');
    });

    it('아는 언어가 하나도 없으면 영어다', () => {
        expect(목록으로(['ja-JP', 'fr-FR'])).toBe('en');
        expect(목록으로([])).toBe('en');
    });
});
