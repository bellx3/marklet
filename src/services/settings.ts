import { Preferences } from '@capacitor/preferences';
import { setLanguage, type LangSetting } from '../i18n';

export const FONT_STEPS = [14, 15, 16, 17, 18, 20, 22, 24] as const;
export const DEFAULT_FONT_STEP = 3; // 17px

export interface AppSettings {
    theme: 'system' | 'light' | 'dark';
    /**
     * 화면 언어 (en · ko 둘뿐). 기본값 `system` 은 기기 설정을 따른다.
     * ★ 바꾸면 앱을 다시 읽는다 — 이유는 src/i18n/index.ts 주석에 있다.
     */
    language: LangSetting;
    /** FONT_STEPS 의 인덱스 */
    fontStep: number;
    /** 한 줄 개행을 <br> 로 (6-10절). 기본 켜짐 */
    breaks: boolean;
    /** 원격 이미지 불러오기 (6-4절). 기본 꺼짐 — 사생활 */
    remoteImages: boolean;
    /** ★ 지금은 아무도 안 본다. 이미 저장된 설정에 있어서 남겨 둘 뿐이다(loadSettings 주석). */
    fontStepInitialized: boolean;
}

const KEY = 'settings';

const DEFAULTS: AppSettings = {
    theme: 'system',
    language: 'system',
    fontStep: DEFAULT_FONT_STEP,
    breaks: true,
    remoteImages: false,
    fontStepInitialized: false,
};

let current: AppSettings = { ...DEFAULTS };
const listeners = new Set<(s: AppSettings) => void>();

export function getSettings(): Readonly<AppSettings> {
    return current;
}

export function onSettingsChange(fn: (s: AppSettings) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function clampStep(i: number): number {
    return Math.min(FONT_STEPS.length - 1, Math.max(0, i | 0));
}

export async function loadSettings(): Promise<AppSettings> {
    try {
        const { value } = await Preferences.get({ key: KEY });
        if (value) current = { ...DEFAULTS, ...JSON.parse(value) };
    } catch {
        // 브라우저(npm run dev)에는 Preferences 네이티브가 없다. 기본값으로 간다.
        current = { ...DEFAULTS };
    }

    /*
     * ★★★ OS 글꼴 배율을 여기서 읽지 마라. **웹뷰가 이미 적용한다.**
     *
     *   예전에는 첫 실행에서 getSystemFontScale() 을 읽어 fontStep 을 올렸다.
     *   근거는 "본문에 text-size-adjust:none 을 걸어 OS 확대를 껐으니 우리가 보정해야
     *   한다" 였는데, **그 전제가 틀렸다.** text-size-adjust 는 뷰포트 메타가 없는
     *   페이지의 '자동 글자 확대' 를 다루는 것이고, 시스템 글꼴 배율은
     *   WebSettings.setTextZoom 이 따로 먹인다 — CSS 로는 못 끈다.
     *
     *   그래서 배율이 **두 번** 곱해졌다(2026-08-06 실기기 실측, 시스템 배율 2.0):
     *     지정 16px  → 실제 32px            (웹뷰가 이미 2배)
     *     --md-font-size 24px → 본문 48px   (앱이 17→24 로 올린 뒤 또 2배)
     *   사용자가 바란 것은 17×2 = 34px 인데 48px 가 나왔다. 어느 배율에서든 30% 초과다.
     *
     *   이제 fontStep 은 **사용자가 설정 화면에서 고른 값** 하나만 뜻한다.
     *   OS 배율은 웹뷰에 맡긴다 — 그쪽이 정확하고, 사용자가 OS 설정을 바꾸면
     *   앱을 다시 안 켜도 따라간다(예전 방식은 첫 실행에만 읽어서 못 따라갔다).
     *
     * ★ fontStepInitialized 는 남겨 둔다. 이미 저장된 설정에 들어 있어서
     *   빼면 그 값이 DEFAULTS 로 되돌아간다 — 지금은 아무도 안 본다.
     */
    applySettings();
    return current;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    current = { ...current, ...patch };
    await persist();
    applySettings();
    for (const fn of listeners) fn(current);
}

async function persist(): Promise<void> {
    try {
        await Preferences.set({ key: KEY, value: JSON.stringify(current) });
    } catch (err) {
        console.error('설정 저장 실패:', err);
    }
}

/** 설정을 DOM 에 반영한다. 상태 변경과 DOM 반영을 한 곳에 모아 둔다. */
export function applySettings(): void {
    // ★ 언어를 먼저 확정한다. 화면들은 만들 때 한 번만 글자를 넣으므로
    //   loadSettings() 단계(= mount 전)에서 정해져 있어야 한다.
    setLanguage(current.language);

    document.documentElement.style.setProperty(
        '--md-font-size',
        `${FONT_STEPS[clampStep(current.fontStep)]}px`,
    );
    applyTheme(current.theme);
}

export function applyTheme(theme: AppSettings['theme']): void {
    const dark =
        theme === 'dark' ||
        (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    // ★ prefers-color-scheme 미디어쿼리만 쓰면 앱 안에서 강제 전환을 못 한다.
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#16181C' : '#FBFBF9');

    // 상태바 아이콘 색. 실패해도 화면은 정상이므로 조용히 넘어간다(웹 환경).
    void (async () => {
        try {
            const { StatusBar, Style } = await import('@capacitor/status-bar');
            await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
        } catch {
            /* 웹 환경 또는 edge-to-edge 라 무시됨 */
        }
    })();
}

/** 시스템 테마가 바뀌면 따라간다. theme==='system' 일 때만 의미가 있다. */
export function watchSystemTheme(): void {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (current.theme === 'system') applyTheme('system');
    });
}
