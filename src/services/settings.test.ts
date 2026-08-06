import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * 11-2절 #22.
 *
 * 회귀: applyTheme 의 StatusBar 호출을 try/catch 밖으로 꺼내면
 *   "StatusBar 가 throw 해도 data-theme 은 적용된다" 가 실패하는 것을 확인함.
 */

const store = new Map<string, string>();
const prefs = {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value);
    }),
};
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: (o: { key: string }) => prefs.get(o),
        set: (o: { key: string; value: string }) => prefs.set(o),
    },
}));

const mdFile = { getSystemFontScale: vi.fn() };
vi.mock('../plugins/md-file', () => ({
    MdFile: { getSystemFontScale: () => mdFile.getSystemFontScale() },
}));

// ★ 네이티브 경계다. 여기서만 목을 만든다(11-1절 2번).
vi.mock('@capacitor/status-bar', () => ({
    StatusBar: {
        setStyle: async () => {
            throw new Error('SystemBars 가 없다');
        },
    },
    Style: { Dark: 'DARK', Light: 'LIGHT' },
}));

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.resetModules();
    document.documentElement.removeAttribute('data-theme');
    document.head.innerHTML = '<meta name="theme-color" content="#FBFBF9">';
});

describe('applyTheme', () => {
    it('★ StatusBar 가 throw 해도 data-theme 은 적용된다 (웹·플러그인 없는 환경)', async () => {
        const { applyTheme } = await import('./settings');
        expect(() => applyTheme('dark')).not.toThrow();
        expect(document.documentElement.dataset.theme).toBe('dark');
        // 비동기 실패가 unhandled rejection 이 되지 않는지도 본다
        await new Promise((r) => setTimeout(r, 0));
    });

    it('system 이면 OS 설정을 따른다', async () => {
        const { applyTheme } = await import('./settings');
        vi.spyOn(window, 'matchMedia').mockReturnValue({
            matches: true,
        } as unknown as MediaQueryList);
        applyTheme('system');
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('theme-color 메타도 함께 바꾼다 (상태바 색이 본문과 이어져야 한다)', async () => {
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

describe('★★ OS 글꼴 배율은 웹뷰에 맡긴다 (10-2절)', () => {
    it('OS 배율을 읽지 않는다 — 읽으면 두 번 곱해진다', async () => {
        mdFile.getSystemFontScale.mockResolvedValue({ scale: 1.3 });
        const { loadSettings, FONT_STEPS, DEFAULT_FONT_STEP } = await import('./settings');

        const s = await loadSettings();

        /*
         * ★★ 이 테스트는 예전에 정반대를 고정했다("배율을 읽어 가장 가까운 단계를 고른다").
         *   근거는 "본문에 text-size-adjust:none 을 걸어 OS 확대를 껐으니 우리가 보정해야
         *   한다" 였는데 **그 전제가 틀렸다.** 시스템 글꼴 배율은 WebSettings.setTextZoom
         *   이 먹이는 것이라 CSS 로는 못 끈다.
         *
         *   그래서 배율이 두 번 곱해졌다(2026-08-06 실기기, 시스템 배율 2.0):
         *     지정 16px → 실제 32px            (웹뷰가 이미 2배)
         *     --md-font-size 24px → 본문 48px  (앱이 17→24 로 올린 뒤 또 2배)
         *   사용자가 바란 것은 17×2 = 34px 였다.
         */
        expect(FONT_STEPS[s.fontStep], '앱이 배율을 또 곱하면 안 된다').toBe(
            FONT_STEPS[DEFAULT_FONT_STEP],
        );
        expect(mdFile.getSystemFontScale, 'OS 배율을 읽으면 안 된다').not.toHaveBeenCalled();
    });

    it('사용자가 고른 값은 그대로 쓴다', async () => {
        store.set(
            'settings',
            JSON.stringify({ fontStep: 1, fontStepInitialized: true, theme: 'light' }),
        );
        const { loadSettings } = await import('./settings');

        const s = await loadSettings();
        expect(s.fontStep).toBe(1);
        expect(mdFile.getSystemFontScale).not.toHaveBeenCalled();
    });

    it('네이티브가 없으면 기본 단계로 간다', async () => {
        mdFile.getSystemFontScale.mockRejectedValue(new Error('not implemented'));
        const { loadSettings, DEFAULT_FONT_STEP } = await import('./settings');
        expect((await loadSettings()).fontStep).toBe(DEFAULT_FONT_STEP);
    });

    it('저장된 값이 깨져 있어도 기본값으로 살아난다', async () => {
        store.set('settings', '{깨진 JSON');
        mdFile.getSystemFontScale.mockResolvedValue({ scale: 1 });
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
    it('구독자에게 알리고 저장한다', async () => {
        mdFile.getSystemFontScale.mockResolvedValue({ scale: 1 });
        const { loadSettings, updateSettings, onSettingsChange } = await import('./settings');
        await loadSettings();

        const seen: number[] = [];
        const off = onSettingsChange((s) => seen.push(s.fontStep));
        await updateSettings({ fontStep: 5 });
        off();
        await updateSettings({ fontStep: 6 });

        expect(seen).toEqual([5]); // 구독 해제 뒤에는 안 온다
        expect(JSON.parse(store.get('settings')!).fontStep).toBe(6);
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
        expect(t?.common?.confirm, '카탈로그가 사라졌다 — 여기서 부팅이 죽는다').toBeTruthy();
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
