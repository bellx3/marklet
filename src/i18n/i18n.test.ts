import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('★ 어순은 언어마다 다르다', () => {
    it('영어 초안 안내는 시각이 문장 뒤로 간다', () => {
        const s = en.shell.draftBody('just now');
        /*
         * ★★ 한국어 틀을 그대로 옮겨 앞에 붙였더니
         *   "just now You have edits left in the app." 이 나왔다(2026-08-06 실기기).
         *   문장 한가운데에서 시작하는 꼴이라 영어로는 말이 안 된다.
         */
        expect(s.startsWith('just now'), '시각이 문장 앞에 붙었다').toBe(false);
        expect(s).toContain('from just now');
    });

    it('한국어는 시각이 앞에 온다 — 그게 자연스럽다', () => {
        expect(ko.shell.draftBody('방금').startsWith('방금')).toBe(true);
    });

    it('시각을 모르면 어느 쪽도 어색해지지 않는다', () => {
        expect(en.shell.draftBody('')).toContain('You have edits left in the app.');
        expect(en.shell.draftBody('')).not.toContain('from');
        expect(ko.shell.draftBody('')).toMatch(/^편집하던/);
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
        expect(t?.common?.confirm, '카탈로그가 사라졌다 — 여기서 부팅이 죽는다').toBeTruthy();
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
 * 문구에 박힌 숫자가 코드의 진짜 상한과 같은가 (2026-08-07).
 *
 * ★★ "파일이 너무 커서 열 수 없습니다. (8MB 초과)" 는 **자바에 있는 상한**을 말한다.
 *   MdFilePlugin.MAX_BYTES 가 8MB 이고, 그걸 넘으면 ETOOBIG 으로 거절한다.
 *   그런데 그 숫자가 자바 상수와 두 언어 문자열에 **각각 따로** 적혀 있다.
 *   한쪽만 바뀌면 앱은 사용자에게 틀린 숫자를 말하게 되고, 그건 화면만 보고는
 *   절대 안 걸린다 — 상한을 넘는 파일이 있어야 뜨는 문구다.
 *
 * ★ 이 저장소는 이미 같은 교훈을 적어 뒀다(folders.ts) —
 *   "상한 값 … 코드에 박아 두면 네이티브와 어긋난다."
 *   네이티브에서 값을 받아 오게 고치는 것이 더 낫지만, read() 는 코드만 돌려준다.
 *   그때까지는 어긋나는 순간 여기서 깨지게 해 둔다.
 */
describe('문구의 숫자가 코드와 맞는가', () => {
    // ★ import.meta.url 은 vite 서버 URL 이라 file: 스킴이 아니다. 저장소 루트 기준으로 읽는다.
    const java = readFileSync(
        'android/app/src/main/java/com/marklet/md/mdfile/MdFilePlugin.java',
        'utf8',
    );

    it('MAX_BYTES 를 읽을 수 있다 (못 읽으면 아래 검사가 헛돈다)', () => {
        expect(java).toMatch(/MAX_BYTES\s*=\s*8L\s*\*\s*1024\s*\*\s*1024/);
    });

    it('★ 두 언어의 tooBig 문구가 같은 MB 를 말한다', () => {
        const m = /MAX_BYTES\s*=\s*(\d+)L?\s*\*\s*1024\s*\*\s*1024/.exec(java);
        expect(m, '자바에서 MAX_BYTES 를 못 찾았다').not.toBeNull();
        const mb = Number(m![1]);

        for (const [name, cat] of [
            ['ko', ko],
            ['en', en],
        ] as const) {
            const 문구 = cat.gate.tooBig;
            const 숫자 = [...문구.matchAll(/(\d+)\s*MB/gi)].map((x) => Number(x[1]));
            expect(숫자, `${name}: tooBig 에 MB 숫자가 없다`).not.toEqual([]);
            expect(숫자, `${name}: 문구가 ${숫자} MB 라는데 코드 상한은 ${mb} MB 다`).toContain(mb);
        }
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
