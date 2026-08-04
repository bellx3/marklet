import {
    FONT_STEPS,
    clampStep,
    getSettings,
    updateSettings,
    type AppSettings,
} from '../../services/settings';
import { createToggleRow } from './view-sheet';
import { clearRecents } from '../../services/recents';
import { TipManager } from '../../services/tip-manager';
import { confirmDialog } from '../../utils/dialog';
import { Toast } from '../../utils/toast';
import { icon, iconButton } from '../icons';
import { t, getLang, type LangSetting } from '../../i18n';

/**
 * S4 설정 화면.
 *
 * ★ 진단 화면은 버전 표시를 5번 연속 탭하면 열린다(12-3절).
 *   메뉴에 두면 일반 사용자에게 혼란스럽고, 아예 없으면 문의를 받았을 때 물어볼 게 없다.
 */
export interface SettingsScreen {
    root: HTMLElement;
    refresh(): void;
}

export interface SettingsCallbacks {
    onBack(): void;
    openTip(): void;
    openDiagnostics(): void;
    /** breaks 가 바뀌면 열려 있는 문서를 다시 그려야 한다 */
    onBreaksChanged(): void;
    /** 원격 이미지 정책이 바뀌어도 마찬가지다 */
    onImagePolicyChanged(): void;
}

export function createSettings(cb: SettingsCallbacks): SettingsScreen {
    const root = document.createElement('div');
    root.className = 'screen screen-settings';

    const bar = document.createElement('div');
    bar.className = 'app-topbar';

    const back = iconButton('back', t.common.back, cb.onBack);

    const title = document.createElement('h1');
    title.className = 'topbar-title';
    title.textContent = t.settings.title;

    bar.append(back, title);

    const main = document.createElement('main');
    main.className = 'home-body';

    /*
     * ── 언어 (en · ko 두 개만)
     *
     * ★★ 언어를 바꾸면 **앱을 다시 읽는다**(location.reload).
     *   화면들은 만들 때 한 번만 글자를 넣으므로, 다시 만들지 않으면 절반만 바뀐다.
     *   화면 전체를 재구성하는 코드를 새로 두는 것보다 이미 있는 부팅 경로를
     *   한 번 더 타는 쪽이 훨씬 덜 틀린다(src/i18n/index.ts 주석).
     *
     * ★ reload 전에 updateSettings 를 **await 한다.** Preferences 쓰기가 끝나기 전에
     *   화면을 날려 버리면 바뀐 언어가 저장되지 않아 그대로 되돌아온다.
     */
    const langRow = row(t.settings.language);
    const langGroup = document.createElement('div');
    langGroup.className = 'seg';
    langGroup.setAttribute('role', 'radiogroup');
    langGroup.setAttribute('aria-label', t.settings.language);
    const LANGS: Array<[LangSetting, string]> = [
        ['system', t.settings.languageSystem],
        ['ko', '한국어'],
        ['en', 'English'],
    ];
    const langBtns = LANGS.map(([value, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-item';
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => {
            if (getSettings().language === value) return;
            void updateSettings({ language: value }).then(() => window.location.reload());
        });
        langGroup.appendChild(b);
        return { b, value };
    });
    langRow.appendChild(langGroup);

    // ── 테마
    const themeRow = row(t.view.theme);
    const themeGroup = document.createElement('div');
    themeGroup.className = 'seg';
    themeGroup.setAttribute('role', 'radiogroup');
    themeGroup.setAttribute('aria-label', t.view.theme);
    const THEMES: Array<[AppSettings['theme'], string]> = [
        ['system', t.view.themeSystem],
        ['light', t.view.themeLight],
        ['dark', t.view.themeDark],
    ];
    const themeBtns = THEMES.map(([value, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-item';
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => void updateSettings({ theme: value }).then(refresh));
        themeGroup.appendChild(b);
        return { b, value };
    });
    themeRow.appendChild(themeGroup);

    // ── 글자 크기
    const sizeRow = row(t.view.fontSize);
    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'seg';
    const smaller = stepBtn('A−', t.view.smaller, -1);
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'seg-label';
    sizeLabel.setAttribute('aria-live', 'polite');
    const bigger = stepBtn('A+', t.view.bigger, +1);
    sizeGroup.append(smaller, sizeLabel, bigger);
    sizeRow.appendChild(sizeGroup);

    const sizePreview = document.createElement('p');
    sizePreview.className = 'size-preview';
    sizePreview.textContent = t.settings.sizePreview;

    // ── 토글
    const breaks = createToggleRow(t.view.breaks, t.view.breaksHint);
    breaks.input.addEventListener('change', () => {
        void updateSettings({ breaks: breaks.input.checked }).then(() => {
            refresh();
            cb.onBreaksChanged();
        });
    });

    const remote = createToggleRow(t.settings.remoteImages, t.settings.remoteImagesHint);
    remote.input.addEventListener('change', () => {
        void updateSettings({ remoteImages: remote.input.checked }).then(() => {
            refresh();
            cb.onImagePolicyChanged();
        });
    });

    // ── 후원
    const tipRow = navRow(t.settings.tip, cb.openTip);
    const badge = document.createElement('span');
    badge.className = 'badge badge--supporter';
    badge.textContent = t.settings.supporter;
    badge.hidden = true;
    tipRow.appendChild(badge);

    // ── 목록 비우기
    const clearRow = navRow(t.settings.clearRecents, () => {
        void (async () => {
            const ok = await confirmDialog({
                title: t.settings.clearTitle,
                body: t.settings.clearBody,
                confirmText: t.settings.clearConfirm,
                destructive: true,
            });
            if (!ok) return;
            await clearRecents();
            Toast.success(t.settings.cleared);
        })();
    });

    // ── 앱 정보
    const about = document.createElement('section');
    about.className = 'home-section';
    const aboutTitle = document.createElement('h2');
    aboutTitle.className = 'home-section-title';
    aboutTitle.textContent = t.settings.about;

    const version = document.createElement('button');
    version.type = 'button';
    version.className = 'setting-row setting-row--nav';
    const vLabel = document.createElement('span');
    vLabel.className = 'setting-label';
    vLabel.textContent = t.settings.version;
    const vValue = document.createElement('span');
    vValue.className = 'setting-value';
    vValue.textContent = __APP_VERSION__;
    version.append(vLabel, vValue);

    // 5번 연속 탭 → 진단 화면. 2초 안에 이어서 눌러야 한다.
    let taps = 0;
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    version.addEventListener('click', () => {
        taps++;
        if (tapTimer !== null) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
            taps = 0;
            tapTimer = null;
        }, 2000);
        if (taps >= 5) {
            taps = 0;
            cb.openDiagnostics();
        }
    });

    const licenses = navRow(t.settings.licenses, () => {
        // 별도 HTML 이라 같은 웹뷰에서 그냥 이동한다. 뒤로가기는 웹뷰 히스토리가 처리한다.
        window.location.href = 'licenses.html';
    });

    /*
     * ★ Play 가 요구하는 '앱 안의 개인정보처리방침 링크'가 이것이다(출시 3-6절).
     *   스토어 등재에만 넣고 앱에는 빼면 심사에서 걸린다.
     */
    const privacy = navRow(t.settings.privacy, () => void openPrivacyPolicy());

    about.append(aboutTitle, version, privacy, licenses);

    /*
     * ★ 소모성 상품이라 '복원'이 없다. 기기를 바꾸면 후원 표시가 사라지는데,
     *   그걸 미리 말하지 않으면 사용자는 결제가 사라졌다고 느낀다(출시 3-6절).
     */
    const tipNote = document.createElement('p');
    tipNote.className = 'setting-hint';
    tipNote.textContent = t.settings.tipNote;
    about.appendChild(tipNote);

    main.append(
        langRow,
        themeRow,
        sizeRow,
        sizePreview,
        breaks.row,
        remote.row,
        tipRow,
        clearRow,
        about,
    );
    root.append(bar, main);

    function stepBtn(label: string, aria: string, delta: number): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-item';
        b.textContent = label;
        b.setAttribute('aria-label', aria);
        b.addEventListener('click', () => {
            void updateSettings({ fontStep: clampStep(getSettings().fontStep + delta) }).then(
                refresh,
            );
        });
        return b;
    }

    function refresh(): void {
        const s = getSettings();
        for (const { b, value } of themeBtns) {
            const on = s.theme === value;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', String(on));
        }
        for (const { b, value } of langBtns) {
            const on = s.language === value;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', String(on));
        }
        const stepIndex = clampStep(s.fontStep);
        sizeLabel.textContent = `${FONT_STEPS[stepIndex]}px`;
        smaller.disabled = stepIndex === 0;
        bigger.disabled = stepIndex === FONT_STEPS.length - 1;
        sizePreview.style.fontSize = `${FONT_STEPS[stepIndex]}px`;
        breaks.input.checked = s.breaks;
        remote.input.checked = s.remoteImages;
        badge.hidden = !TipManager.isSupporter;
    }

    return { root, refresh };
}

/**
 * 개인정보처리방침을 시스템 브라우저로 연다.
 * ★ 앱 안 웹뷰에서 열지 마라 — 외부 페이지를 우리 웹뷰에 띄우면 CSP 와 뒤로가기가 꼬인다.
 */
const PRIVACY_URL_EN = 'https://bellx3.github.io/marklet-privacy/';
const PRIVACY_URL_KO = 'https://bellx3.github.io/marklet-privacy/ko/';

async function openPrivacyPolicy(): Promise<void> {
    // ★ navigator.language 가 아니라 **앱 언어**를 본다. 앱을 영어로 쓰는 한국 사용자에게
    //   한국어 방침 페이지가 열리면 앞뒤가 맞지 않는다.
    const url = getLang() === 'ko' ? PRIVACY_URL_KO : PRIVACY_URL_EN;
    try {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
    } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

function row(label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'setting-row';
    const l = document.createElement('span');
    l.className = 'setting-label';
    l.textContent = label;
    el.appendChild(l);
    return el;
}

function navRow(label: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'setting-row setting-row--nav';
    const l = document.createElement('span');
    l.className = 'setting-label';
    l.textContent = label;
    const chevron = document.createElement('span');
    chevron.className = 'setting-chevron';
    chevron.appendChild(icon('right', 16));
    b.append(l, chevron);
    b.addEventListener('click', onClick);
    return b;
}
