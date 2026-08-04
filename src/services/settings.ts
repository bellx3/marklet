import { Preferences } from '@capacitor/preferences';
import { MdFile } from '../plugins/md-file';
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
    /** 첫 실행에서 OS 글꼴 배율을 반영했는지 */
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

    // 첫 실행에서만: OS 글꼴 크기 설정을 반영한다(접근성, 10-2절).
    if (!current.fontStepInitialized) {
        current.fontStep = await initialFontStepFromSystem();
        current.fontStepInitialized = true;
        await persist();
    }

    applySettings();
    return current;
}

/**
 * OS 의 글꼴 배율(1.0 = 기본, 1.3 = 크게 ...)에 가장 가까운 단계를 고른다.
 * 본문에 text-size-adjust:none 을 걸어 OS 확대를 끄기 때문에 이 보정이 없으면
 * 시스템 글꼴을 키워 둔 사용자가 앱만 작게 보게 된다.
 *
 * ★ 실패하면 저장까지 하지 않도록 fontStepInitialized 를 세우기 전에 예외로 빠져나온다 —
 *   웹 미리보기에서 한 번 true 로 굳으면 실기기 첫 실행에서 배율을 영영 못 읽는다.
 *   (여기서는 catch 로 DEFAULT 를 돌려주지만 웹은 Preferences 자체가 없어 저장도 안 된다.)
 */
async function initialFontStepFromSystem(): Promise<number> {
    let scale = 1;
    try {
        scale = (await MdFile.getSystemFontScale()).scale || 1;
    } catch {
        return DEFAULT_FONT_STEP; // 웹 미리보기 등
    }
    const target = FONT_STEPS[DEFAULT_FONT_STEP] * scale;
    let best = DEFAULT_FONT_STEP;
    for (let i = 0; i < FONT_STEPS.length; i++) {
        if (Math.abs(FONT_STEPS[i] - target) < Math.abs(FONT_STEPS[best] - target)) best = i;
    }
    return best;
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
