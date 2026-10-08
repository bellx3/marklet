import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * 11-2절 #22.
 *
 * 설정은 웹뷰의 localStorage 에 JSON 한 덩이로 저장된다(settings.ts). 시험은 jsdom 의 진짜 localStorage 를 쓴다.
 */

const store = {
    set: (key: string, value: string) => localStorage.setItem(`marklet.${key}`, value),
    get: (key: string) => localStorage.getItem(`marklet.${key}`) ?? undefined,
    clear: () => localStorage.clear(),
};

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.resetModules();
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color" content="#FBFBF9">';
});

describe('applyTheme', () => {
    it('테마를 data-theme 에 적용한다', async () => {
        const { applyTheme } = await import('./settings');
        applyTheme('dark');
        expect(document.documentElement.dataset.theme).toBe('dark');
        applyTheme('light');
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('system 이면 OS 설정을 따른다', async () => {
        const { applyTheme } = await import('./settings');
        vi.spyOn(window, 'matchMedia').mockReturnValue({
            matches: true,
        } as unknown as MediaQueryList);
        applyTheme('system');
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('theme-color 메타도 함께 바꾼다', async () => {
        const { applyTheme } = await import('./settings');
        applyTheme('dark');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
            '#16181C',
        );
        applyTheme('light');
        expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
            '#FBFBF9',
        );
    });
});

describe('글꼴 단계 (10-2절)', () => {
    /*
     * ★★ 앱은 OS 글꼴 배율을 읽지 않는다. 웹뷰가 이미 적용하므로 앱이 또 곱하면 두 번 곱해진다
     *   (2026-08-06 실측: 시스템 배율 2.0 에서 지정 17px 가 34px 가 아니라 48px 로 나왔다).
     *   그래서 fontStep 은 사용자가 설정에서 고른 값 하나만 뜻한다.
     */
    it('저장된 값이 없으면 기본 단계다', async () => {
        const { loadSettings, FONT_STEPS, DEFAULT_FONT_STEP } = await import('./settings');
        const s = await loadSettings();
        expect(FONT_STEPS[s.fontStep]).toBe(FONT_STEPS[DEFAULT_FONT_STEP]);
    });

    it('사용자가 고른 값은 그대로 쓴다', async () => {
        store.set(
            'settings',
            JSON.stringify({ fontStep: 1, fontStepInitialized: true, theme: 'light' }),
        );
        const { loadSettings } = await import('./settings');

        const s = await loadSettings();
        expect(s.fontStep).toBe(1);
    });

    it('저장된 값이 깨져 있어도 기본값으로 살아난다', async () => {
        store.set('settings', '{깨진 JSON');
        const { loadSettings, DEFAULT_FONT_STEP } = await import('./settings');
        expect((await loadSettings()).fontStep).toBe(DEFAULT_FONT_STEP);
    });
});

describe('clampStep', () => {
    it('범위를 벗어나면 잘라 낸다', async () => {
        const { clampStep, FONT_STEPS } = await import('./settings');
        expect(clampStep(-5)).toBe(0);
        expect(clampStep(999)).toBe(FONT_STEPS.length - 1);
        expect(clampStep(3)).toBe(3);
    });
});

describe('updateSettings', () => {
    it('바꾼 값을 저장하고 화면에 반영한다', async () => {
        const { loadSettings, updateSettings } = await import('./settings');
        await loadSettings();

        await updateSettings({ fontStep: 5 });
        await updateSettings({ fontStep: 6, theme: 'dark' });

        expect(JSON.parse(store.get('settings')!)).toMatchObject({ fontStep: 6, theme: 'dark' });
        expect(document.documentElement.dataset.theme).toBe('dark');
    });
});

/**
 * ★★★ 2026-08-06. **저장된 설정 하나로 앱이 영영 안 켜질 수 있었다.**
 *
 *   loadSettings 는 `{ ...DEFAULTS, ...JSON.parse(value) }` 로 저장값을 그대로 합쳤다.
 *   그런데 language 에 모르는 값이 들어 있으면 CATALOGS[그 값] 이 undefined 가 되어
 *   `t` 가 통째로 사라지고 **첫 `t.어쩌구` 에서 부팅이 죽는다.**
 *   저장된 값이라 **켤 때마다 같은 자리에서 죽고**, 앱 데이터를 지우는 것 말고는
 *   빠져나갈 길이 없다 — 최근 문서·폴더·저장 안 한 초안까지 같이 잃는다.
 *
 *   어떻게 들어가나: 나중 판이 언어를 늘렸다가 사용자가 옛 판으로 되돌리는 경우,
 *   저장소가 부분적으로 깨진 경우, 우리 쪽 실수. 어느 쪽이든 **한 번 들어가면
 *   사용자가 스스로 못 고친다.**
 */
describe('★★ 망가진 설정으로도 켜진다', () => {
    async function 저장하고읽기(값: unknown) {
        store.set('settings', JSON.stringify(값));
        const { loadSettings } = await import('./settings');
        return loadSettings();
    }

    it('★ 모르는 언어가 들어 있어도 부팅이 죽지 않는다', async () => {
        const s = await 저장하고읽기({ language: 'fr' });
        expect(s.language).toBe('system');

        const { t } = await import('../i18n');
        expect(t?.common?.close, '카탈로그가 사라졌다 — 여기서 부팅이 죽는다').toBeTruthy();
    });

    it.each([
        ['null', null],
        ['숫자', 3],
        ['빈 문자열', ''],
        ['객체', { a: 1 }],
    ])('language 가 %s 여도 기본값으로 되돌린다', async (_이름, 값) => {
        const s = await 저장하고읽기({ language: 값 });
        expect(s.language).toBe('system');
    });

    it('모르는 테마도 기본값으로 되돌린다', async () => {
        expect((await 저장하고읽기({ theme: 'blue' })).theme).toBe('system');
    });

    /*
     * ★ 예전에는 'abc' 가 들어오면 `| 0` 으로 0이 되어 **글자가 가장 작게** 바뀌었다.
     *   이상한 값 때문에 글자가 줄어드는 것보다 기본값이 낫다.
     */
    it('★ 글꼴 단계가 숫자가 아니면 가장 작게가 아니라 기본값이다', async () => {
        const s = await 저장하고읽기({ fontStep: 'abc' });
        const { DEFAULT_FONT_STEP } = await import('./settings');
        expect(s.fontStep).toBe(DEFAULT_FONT_STEP);
    });

    it('글꼴 단계가 범위를 벗어나면 잘라 낸다', async () => {
        const { FONT_STEPS } = await import('./settings');
        expect((await 저장하고읽기({ fontStep: 999 })).fontStep).toBe(FONT_STEPS.length - 1);
        expect((await 저장하고읽기({ fontStep: -5 })).fontStep).toBe(0);
    });

    it('참/거짓이 아닌 값도 기본값으로 되돌린다', async () => {
        const s = await 저장하고읽기({ breaks: 'yes', remoteImages: 1 });
        expect(s.breaks).toBe(true);
        expect(s.remoteImages).toBe(false);
    });

    it('JSON 자체가 깨져 있어도 켜진다', async () => {
        store.set('settings', '{이건 JSON 이 아니다');
        const { loadSettings } = await import('./settings');
        const s = await loadSettings();
        const { DEFAULT_FONT_STEP } = await import('./settings');
        expect(s.language).toBe('system');
        expect(s.fontStep).toBe(DEFAULT_FONT_STEP);
    });

    it('멀쩡한 설정은 그대로 살린다 (전부 기본값으로 밀어 버리지 않는다)', async () => {
        const s = await 저장하고읽기({
            theme: 'dark',
            language: 'ko',
            fontStep: 6,
            breaks: false,
            remoteImages: true,
        });
        expect(s).toMatchObject({
            theme: 'dark',
            language: 'ko',
            fontStep: 6,
            breaks: false,
            remoteImages: true,
        });
    });
});
