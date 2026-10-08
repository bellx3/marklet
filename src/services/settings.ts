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
}

/** localStorage 키. 이 앱의 웹뷰 저장소는 앱 전용이라 다른 곳과 섞이지 않지만, 접두를 붙여 둔다. */
const KEY = 'marklet.settings';

const DEFAULTS: AppSettings = {
    theme: 'system',
    language: 'system',
    fontStep: DEFAULT_FONT_STEP,
    breaks: true,
    remoteImages: false,
};

let current: AppSettings = { ...DEFAULTS };

export function getSettings(): Readonly<AppSettings> {
    return current;
}

export function clampStep(i: number): number {
    return Math.min(FONT_STEPS.length - 1, Math.max(0, i | 0));
}

/**
 * 저장된 값을 **믿지 않고** 걸러 낸다.
 *
 * ★★★ 예전에는 `{ ...DEFAULTS, ...JSON.parse(value) }` 로 그대로 합쳤다.
 *   그런데 language 에 모르는 값이 들어 있으면 CATALOGS[그 값] 이 undefined 가 되어
 *   `t` 가 통째로 사라지고 첫 `t.어쩌구` 에서 **부팅이 죽는다.**
 *   저장된 값이라 **켤 때마다 같은 자리에서 죽고**, 앱 데이터를 지우는 것 말고는
 *   빠져나갈 길이 없다 — 최근 문서·폴더·초안까지 같이 잃는다(2026-08-06 실측).
 *
 *   어떻게 그런 값이 들어가나: 나중 판이 언어를 늘렸다가 사용자가 옛 판으로 되돌리는
 *   경우, 저장소가 부분적으로 깨진 경우, 우리 쪽 실수. 어느 쪽이든 **한 번 들어가면
 *   사용자가 스스로 못 고친다** — 그게 이 검사를 넣는 이유다.
 *
 * ★ 이상한 값은 조용히 기본값으로 되돌린다. 설정 하나 되돌아가는 것과
 *   앱이 안 켜지는 것은 견줄 수 없다.
 * ★ fontStep 도 숫자인지 본다. 예전에는 'abc' 가 들어오면 `| 0` 으로 0이 되어
 *   **글자가 가장 작게** 바뀌었다 — 기본값(17px)으로 두는 게 맞다.
 */
function sanitize(raw: unknown): AppSettings {
    const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
    const oneOf = <T extends string>(x: unknown, allowed: readonly T[], fallback: T): T =>
        (allowed as readonly unknown[]).includes(x) ? (x as T) : fallback;

    return {
        theme: oneOf(v.theme, ['system', 'light', 'dark'] as const, DEFAULTS.theme),
        language: oneOf(v.language, ['system', 'en', 'ko'] as const, DEFAULTS.language),
        fontStep: clampStep(typeof v.fontStep === 'number' ? v.fontStep : DEFAULTS.fontStep),
        breaks: typeof v.breaks === 'boolean' ? v.breaks : DEFAULTS.breaks,
        remoteImages: typeof v.remoteImages === 'boolean' ? v.remoteImages : DEFAULTS.remoteImages,
    };
}

export async function loadSettings(): Promise<AppSettings> {
    try {
        const value = localStorage.getItem(KEY);
        current = value ? sanitize(JSON.parse(value)) : { ...DEFAULTS };
    } catch {
        // 저장소를 못 읽거나 JSON 이 깨진 경우다 — 둘 다 기본값이 맞다.
        current = { ...DEFAULTS };
    }

    // ★ OS 글꼴 배율을 여기서 읽지 마라. 웹뷰가 이미 적용하므로 앱이 또 곱하면 두 번 곱해진다.
    //   fontStep 은 저장된 값 하나만 뜻한다(확대 · 축소는 Rust 쪽 zoom 이 맡는다).
    applySettings();
    return current;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    current = { ...current, ...patch };
    await persist();
    applySettings();
}

async function persist(): Promise<void> {
    try {
        localStorage.setItem(KEY, JSON.stringify(current));
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
}
