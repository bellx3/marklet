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

describe('loadSettings — 첫 실행 글꼴 배율 (10-2절)', () => {
    it('★ 첫 실행에서 OS 글꼴 배율을 읽어 가장 가까운 단계를 고른다', async () => {
        mdFile.getSystemFontScale.mockResolvedValue({ scale: 1.3 });
        const { loadSettings, FONT_STEPS, getSettings } = await import('./settings');

        const s = await loadSettings();
        // 17 * 1.3 = 22.1 → 22px 단계
        expect(FONT_STEPS[s.fontStep]).toBe(22);
        expect(getSettings().fontStepInitialized).toBe(true);
    });

    it('두 번째 실행에서는 다시 읽지 않는다 (사용자가 고른 값을 덮어쓰면 안 된다)', async () => {
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
