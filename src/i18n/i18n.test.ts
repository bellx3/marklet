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
 *   ③ 뜻이 달라지면 안 되는 문장(저장 실패 안내)이 두 언어에서 같은 약속을 하는지
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

describe('★ 뜻이 달라지면 안 되는 문장', () => {
    /*
     * 저장 실패 안내는 이 앱에서 가장 위험한 문장이다(5-6절).
     * "파일은 그대로 남아 있습니다" 는 백업이 '원본을 못 읽어서' 실패한 경우 **거짓말이 된다.**
     * 두 언어 모두 "우리가 건드리지 않았다"만 말해야 한다.
     */
    it('백업 실패 안내가 원본의 상태를 단정하지 않는다', () => {
        expect(ko.save.backupFailed).toContain('건드리지 않았습니다');
        expect(ko.save.backupFailed).not.toContain('그대로 남아');
        expect(en.save.backupFailed).toContain('did not touch');
        expect(en.save.backupFailed.toLowerCase()).not.toContain('is still there');
    });

    it('사본 안내는 두 언어 모두 [파일 열기] 로 다시 고르라고 말한다', () => {
        expect(ko.viewer.snapshotNotice).toContain('파일 열기');
        expect(en.viewer.snapshotNotice).toContain('Open file');
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
        expect(t.common.cancel).toBe(en.common.cancel);
        setLanguage('ko');
        expect(t.common.cancel).toBe(ko.common.cancel);
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
