import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S4 설정 화면.
 *
 * ★★ 이 화면은 오늘까지 **시험 자체가 불가능했다.**
 *   vitest.config.ts 에 define 이 없어 __APP_VERSION__ 을 쓰는 이 모듈은
 *   import 하는 순간 ReferenceError 로 죽었다. 그래서 여기부터 덮는다.
 *
 * ★ 지키려는 것: 라디오의 접근성 상태 · 글자 크기 상하한 · 숨은 진단 화면 ·
 *   그리고 **언어를 바꿀 때 저장이 끝난 뒤에 다시 읽는 것**.
 *   순서가 뒤집히면 바꾼 언어가 저장되지 않아 그대로 되돌아온다.
 */

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    reload: vi.fn(),
    /** reload 가 불린 시점에 저장소에 무엇이 들어 있었는지 */
    langAtReload: [] as Array<string | null>,
    supporter: { value: false },
    confirmAnswer: { value: true },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: h.store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            h.store.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            h.store.delete(key);
        },
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        mkdir: vi.fn(async () => {}),
        writeFile: vi.fn(async () => ({ uri: '' })),
        deleteFile: vi.fn(async () => {}),
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('../../plugins/md-file', () => ({
    MdFile: {
        releaseUri: vi.fn(async () => {}),
        getSystemFontScale: vi.fn(async () => ({ scale: 1 })),
    },
}));

vi.mock('../../utils/dialog', () => ({
    confirmDialog: async () => h.confirmAnswer.value,
    alertDialog: async () => {},
    choiceDialog: async () => null,
}));

vi.mock('../../services/tip-manager', () => ({
    TipManager: {
        get isSupporter() {
            return h.supporter.value;
        },
    },
}));

import { createSettings, type SettingsScreen } from './settings';
import { FONT_STEPS, loadSettings, getSettings, updateSettings } from '../../services/settings';
import { t } from '../../i18n';

const cb = {
    onBack: vi.fn(),
    openTip: vi.fn(),
    openDiagnostics: vi.fn(),
    onBreaksChanged: vi.fn(),
    onImagePolicyChanged: vi.fn(),
};

let screen: SettingsScreen;

/** 라벨 글자로 설정 줄(버튼)을 찾는다. */
function rowByLabel(label: string): HTMLButtonElement | null {
    return (
        [...screen.root.querySelectorAll<HTMLButtonElement>('.setting-row--nav')].find(
            (b) => b.querySelector('.setting-label')?.textContent === label,
        ) ?? null
    );
}

/**
 * 라디오 묶음 안에서 항목을 찾는다.
 * ★ 묶음 이름을 반드시 받는다 — 테마와 언어에 **똑같이 '시스템'** 이 있어서
 *   화면 전체에서 글자로 찾으면 엉뚱한 쪽이 잡힌다.
 *   (TalkBack 은 묶음의 aria-label 을 함께 읽어 주므로 사용자에게는 안 헷갈린다)
 */
function segByText(groupLabel: string, text: string): HTMLButtonElement | null {
    const group = screen.root.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`);
    expect(group, `'${groupLabel}' 라디오 묶음이 없다`).not.toBeNull();
    return (
        [...group!.querySelectorAll<HTMLButtonElement>('.seg-item')].find(
            (b) => b.textContent === text,
        ) ?? null
    );
}

function btnByAria(label: string): HTMLButtonElement | null {
    return (
        [...screen.root.querySelectorAll<HTMLButtonElement>('button')].find(
            (b) => b.getAttribute('aria-label') === label,
        ) ?? null
    );
}

beforeEach(async () => {
    vi.useFakeTimers();
    h.store.clear();
    h.reload.mockClear();
    h.langAtReload.length = 0;
    h.supporter.value = false;
    h.confirmAnswer.value = true;
    Object.values(cb).forEach((f) => f.mockClear());

    // location.reload — jsdom 은 "Not implemented" 를 던진다. 불렸는지만 본다.
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
            ...window.location,
            href: window.location.href,
            reload: () => {
                h.langAtReload.push(h.store.get('settings') ?? null);
                h.reload();
            },
        },
    });

    await loadSettings();
    screen = createSettings(cb);
    document.body.appendChild(screen.root);
    screen.refresh();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('테마 · 언어 라디오', () => {
    it('지금 값에 aria-checked 를 건다', () => {
        // 기본은 system 이다.
        expect(segByText(t.view.theme, t.view.themeSystem)?.getAttribute('aria-checked')).toBe(
            'true',
        );
        expect(segByText(t.view.theme, t.view.themeDark)?.getAttribute('aria-checked')).toBe(
            'false',
        );
    });

    it('고르면 저장되고 표시가 옮겨간다', async () => {
        segByText(t.view.theme, t.view.themeDark)!.click();
        await vi.advanceTimersByTimeAsync(50);

        expect(getSettings().theme).toBe('dark');
        expect(segByText(t.view.theme, t.view.themeDark)?.getAttribute('aria-checked')).toBe(
            'true',
        );
        expect(segByText(t.view.theme, t.view.themeSystem)?.getAttribute('aria-checked')).toBe(
            'false',
        );
    });

    it('라디오 묶음에 접근성 이름이 있다', () => {
        const groups = [...screen.root.querySelectorAll('[role="radiogroup"]')];
        expect(groups.length).toBeGreaterThanOrEqual(2);
        for (const g of groups) expect(g.getAttribute('aria-label')).toBeTruthy();
    });
});

describe('★ 언어 바꾸기', () => {
    it('저장이 끝난 뒤에 다시 읽는다', async () => {
        segByText(t.settings.language, 'English')!.click();
        await vi.advanceTimersByTimeAsync(50);

        expect(h.reload).toHaveBeenCalledOnce();
        /*
         * ★★ 순서가 뒤집히면(reload 먼저) Preferences 쓰기가 끝나기 전에 화면이 날아가
         *   바꾼 언어가 저장되지 않는다 — 사용자는 영어를 골랐는데 한국어로 되돌아온다.
         *   reload 하는 순간 저장소에 이미 en 이 들어 있어야 한다.
         */
        expect(h.langAtReload[0]).toContain('"language":"en"');
    });

    it('같은 언어를 다시 누르면 다시 읽지 않는다', async () => {
        await updateSettings({ language: 'en' });
        screen.refresh();

        segByText(t.settings.language, 'English')!.click();
        await vi.advanceTimersByTimeAsync(50);

        // 헛되이 앱을 다시 읽으면 읽던 문서가 닫힌다.
        expect(h.reload).not.toHaveBeenCalled();
    });
});

describe('글자 크기', () => {
    it('현재 크기를 px 로 읽어 준다', () => {
        expect(screen.root.querySelector('.seg-label')?.textContent).toBe(
            `${FONT_STEPS[getSettings().fontStep]}px`,
        );
    });

    it('미리보기 글자가 실제로 그 크기다', async () => {
        btnByAria(t.view.bigger)!.click();
        await vi.advanceTimersByTimeAsync(50);
        const preview = screen.root.querySelector<HTMLElement>('.size-preview')!;
        expect(preview.style.fontSize).toBe(`${FONT_STEPS[getSettings().fontStep]}px`);
    });

    it('★ 상하한에서 버튼을 잠근다', async () => {
        await updateSettings({ fontStep: 0 });
        screen.refresh();
        expect(btnByAria(t.view.smaller)!.disabled).toBe(true);
        expect(btnByAria(t.view.bigger)!.disabled).toBe(false);

        await updateSettings({ fontStep: FONT_STEPS.length - 1 });
        screen.refresh();
        expect(btnByAria(t.view.smaller)!.disabled).toBe(false);
        expect(btnByAria(t.view.bigger)!.disabled).toBe(true);
    });

    it('크기 표시는 소리로도 읽힌다', () => {
        expect(screen.root.querySelector('.seg-label')?.getAttribute('aria-live')).toBe('polite');
    });
});

describe('토글', () => {
    it('한 줄 개행을 켜면 열려 있는 문서를 다시 그리게 한다', async () => {
        const input = [
            ...screen.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
        ][0];
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(50);

        expect(getSettings().breaks).toBe(true);
        // 다시 그리지 않으면 설정만 바뀌고 화면은 그대로다 — 사용자는 안 먹혔다고 본다.
        expect(cb.onBreaksChanged).toHaveBeenCalled();
    });

    it('원격 이미지도 마찬가지다', async () => {
        const input = [
            ...screen.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
        ][1];
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(50);

        expect(getSettings().remoteImages).toBe(true);
        expect(cb.onImagePolicyChanged).toHaveBeenCalled();
    });
});

describe('후원 배지', () => {
    it('후원 전에는 감춘다', () => {
        expect(screen.root.querySelector<HTMLElement>('.badge--supporter')!.hidden).toBe(true);
    });

    it('후원했으면 refresh 때 켠다', () => {
        h.supporter.value = true;
        screen.refresh();
        expect(screen.root.querySelector<HTMLElement>('.badge--supporter')!.hidden).toBe(false);
    });
});

describe('★ 숨은 진단 화면 (12-3절)', () => {
    function tapVersion(times: number): void {
        const version = rowByLabel(t.settings.version)!;
        for (let i = 0; i < times; i++) version.click();
    }

    it('5번 연속 눌러야 열린다', () => {
        tapVersion(4);
        expect(cb.openDiagnostics).not.toHaveBeenCalled();
        tapVersion(1);
        expect(cb.openDiagnostics).toHaveBeenCalledOnce();
    });

    it('2초가 지나면 처음부터 다시 센다', async () => {
        tapVersion(4);
        await vi.advanceTimersByTimeAsync(2100);
        tapVersion(4);
        expect(cb.openDiagnostics).not.toHaveBeenCalled();
        tapVersion(1);
        expect(cb.openDiagnostics).toHaveBeenCalledOnce();
    });

    it('버전 글자를 실제로 보여 준다', () => {
        expect(
            rowByLabel(t.settings.version)?.querySelector('.setting-value')?.textContent,
        ).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

describe('앱 정보', () => {
    it('개인정보처리방침 줄이 있다 — Play 심사 요건이다', () => {
        expect(rowByLabel(t.settings.privacy)).not.toBeNull();
    });

    it('오픈소스 라이선스 줄이 있다', () => {
        expect(rowByLabel(t.settings.licenses)).not.toBeNull();
    });

    it('★ 기기를 바꾸면 후원 표시가 사라진다고 미리 말한다', () => {
        // 소모성 상품이라 복원이 없다. 안 말하면 결제가 사라졌다고 느낀다(출시 3-6절).
        const hints = [...screen.root.querySelectorAll('.setting-hint')].map((e) => e.textContent);
        expect(hints).toContain(t.settings.tipNote);
    });
});

describe('목록 비우기', () => {
    it('물어보고 나서 지운다', async () => {
        h.store.set(
            'recentDocs',
            JSON.stringify([
                {
                    uri: 'content://a',
                    name: 'a.md',
                    lastOpened: 1,
                    persisted: true,
                    size: 1,
                    source: 'picker',
                },
            ]),
        );
        rowByLabel(t.settings.clearRecents)!.click();
        await vi.advanceTimersByTimeAsync(50);
        expect(h.store.get('recentDocs')).toBe('[]');
    });

    it('아니라고 하면 건드리지 않는다', async () => {
        h.store.set('recentDocs', '[{"uri":"content://a","name":"a.md"}]');
        h.confirmAnswer.value = false;

        rowByLabel(t.settings.clearRecents)!.click();
        await vi.advanceTimersByTimeAsync(50);

        expect(h.store.get('recentDocs')).toContain('a.md');
    });
});
