import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 바닥 시트 둘 — 목차(T1) · 보기 설정(T3).
 *
 * ★★ 시트에서 위험한 것은 내용이 아니라 **수명주기**다.
 *   여는 순간 back 레이어를 얹고 닫기 시작하는 순간 떼야 한다(9-4절).
 *   한 박자만 어긋나도 화면에 없는 시트가 뒤로가기 한 번을 먹는다 —
 *   사용자에게는 "뒤로가기가 씹혔다" 로 보이고, 원인은 어디에도 안 남는다.
 *   픽셀오아시스 커밋 13195dc 가 그 사고였다.
 */

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
}));

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: vi.fn(async () => {}),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
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

vi.mock('../../plugins/md-file', () => ({
    MdFile: { getSystemFontScale: vi.fn(async () => ({ scale: 1 })) },
}));

import { createTocSheet } from './toc-sheet';
import { createViewSheet } from './view-sheet';
import { __resetRouterForTest, __pressBackForTest, hasLayer } from '../router';
import { FONT_STEPS, loadSettings, getSettings, updateSettings } from '../../services/settings';
import { t } from '../../i18n';
import type { Heading, RenderHandle } from '../../markdown/render-pipeline';

let container: HTMLElement;

function sheetOf(id: string): HTMLElement {
    return document.querySelector<HTMLElement>(`[aria-labelledby="${id}-title"]`)!;
}

function itemsOf(id: string): string[] {
    return [...sheetOf(id).querySelectorAll('.list-item')].map((e) => e.textContent ?? '');
}

beforeEach(async () => {
    vi.useFakeTimers();
    h.store.clear();
    __resetRouterForTest();
    // 모션 줄이기 — 오버레이가 타이머 없이 즉시 확정된다.
    vi.spyOn(window, 'matchMedia').mockImplementation(
        (q: string) =>
            ({
                matches: q.includes('prefers-reduced-motion'),
                media: q,
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }) as unknown as MediaQueryList,
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    await loadSettings();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

// ────────────────────────────────────────────────────────────
// 목차 시트
// ────────────────────────────────────────────────────────────

const noHandle = (): RenderHandle | null => null;

function headings(...texts: string[]): Heading[] {
    return texts.map((text, i) => ({ text, id: `h-${i}`, level: i === 0 ? 1 : 2, line: i }));
}

describe('목차 시트', () => {
    it('제목들을 그린다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('머리말', '본론', '맺음말'));

        expect(itemsOf('toc')).toEqual(['머리말', '본론', '맺음말']);
        expect(sheetOf('toc').hidden).toBe(false);
    });

    it('계층을 단계로 남긴다 — 들여쓰기는 CSS 가 한다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('큰 제목', '작은 제목'));

        const levels = [...sheetOf('toc').querySelectorAll<HTMLElement>('.toc-item')].map(
            (e) => e.dataset.level,
        );
        expect(levels).toEqual(['1', '2']);
    });

    it('제목이 없으면 그렇게 말한다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open([]);
        expect(sheetOf('toc').querySelector('.sheet-empty')?.textContent).toBe(t.toc.empty);
    });

    it('빈 제목도 자리를 지킨다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open([{ text: '', id: 'x', level: 1, line: 0 }]);
        // 아무 글자도 없으면 누를 것이 안 보인다.
        expect(itemsOf('toc')).toEqual([t.toc.untitled]);
    });

    it('★ 다시 열면 앞 문서의 제목이 남지 않는다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('앞 문서 제목'));
        toc.close();
        toc.open(headings('새 문서 제목'));

        expect(itemsOf('toc')).toEqual(['새 문서 제목']);
    });

    it('첫 항목에 포커스가 간다 — 소리로 읽는 사람이 바로 고를 수 있다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('첫째', '둘째'));

        const first = sheetOf('toc').querySelector<HTMLElement>('.toc-item')!;
        expect(first.dataset.autofocus).toBe('');
    });

    it('★ 여는 순간 back 레이어를 얹고 닫는 순간 뗀다', async () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('제목'));
        expect(hasLayer('toc')).toBe(true);

        expect(await __pressBackForTest()).toBe('toc');
        // ★ 애니메이션을 기다렸다 떼면 그 사이 뒤로가기 한 번을 먹는다.
        expect(hasLayer('toc')).toBe(false);
    });

    it('항목을 누르면 닫힌다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('제목'));

        sheetOf('toc').querySelector<HTMLButtonElement>('.toc-item')!.click();

        expect(hasLayer('toc')).toBe(false);
    });

    it('배경을 누르면 닫힌다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('제목'));

        sheetOf('toc').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(hasLayer('toc')).toBe(false);
    });

    it('destroy 하면 DOM 에서도 사라진다', () => {
        const toc = createTocSheet(container, noHandle);
        toc.open(headings('제목'));
        toc.destroy();

        expect(document.querySelector('[aria-labelledby="toc-title"]')).toBeNull();
        expect(hasLayer('toc')).toBe(false);
    });

    it('닫혀 있을 때 닫아도 레이어를 건드리지 않는다', async () => {
        const toc = createTocSheet(container, noHandle);
        toc.close();
        expect(await __pressBackForTest()).toBeNull();
    });
});

// ────────────────────────────────────────────────────────────
// 보기 설정 시트
// ────────────────────────────────────────────────────────────

function segOf(text: string): HTMLButtonElement {
    return [...sheetOf('view').querySelectorAll<HTMLButtonElement>('.seg-item')].find(
        (b) => b.textContent === text,
    )!;
}

function ariaBtn(label: string): HTMLButtonElement {
    return [...sheetOf('view').querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.getAttribute('aria-label') === label,
    )!;
}

describe('보기 설정 시트', () => {
    it('★ 열 때마다 지금 설정을 다시 읽는다', async () => {
        const sheet = createViewSheet(() => {});
        sheet.open();
        expect(segOf(t.view.themeDark).getAttribute('aria-checked')).toBe('false');
        sheet.close();

        // 설정 화면에서 바꾸고 돌아온 상황.
        await updateSettings({ theme: 'dark' });
        sheet.open();

        /*
         * ★★ 다시 안 읽으면 시트가 **거짓말을 한다** — 다크인데 '시스템'에 표시가 있다.
         *   사용자는 자기가 뭘 골랐는지 화면을 믿을 수 없게 된다.
         */
        expect(segOf(t.view.themeDark).getAttribute('aria-checked')).toBe('true');
    });

    it('테마를 고르면 저장된다', async () => {
        const sheet = createViewSheet(() => {});
        sheet.open();

        segOf(t.view.themeLight).click();
        await vi.advanceTimersByTimeAsync(50);

        expect(getSettings().theme).toBe('light');
        expect(segOf(t.view.themeLight).getAttribute('aria-checked')).toBe('true');
    });

    it('글자 크기 상하한에서 버튼을 잠근다', async () => {
        const sheet = createViewSheet(() => {});
        await updateSettings({ fontStep: 0 });
        sheet.open();
        expect(ariaBtn(t.view.smaller).disabled).toBe(true);

        await updateSettings({ fontStep: FONT_STEPS.length - 1 });
        sheet.open();
        expect(ariaBtn(t.view.bigger).disabled).toBe(true);
        expect(ariaBtn(t.view.smaller).disabled).toBe(false);
    });

    it('현재 크기를 px 로 읽어 주고 소리로도 알린다', () => {
        const sheet = createViewSheet(() => {});
        sheet.open();
        const label = sheetOf('view').querySelector('.seg-label')!;
        expect(label.textContent).toBe(`${FONT_STEPS[getSettings().fontStep]}px`);
        expect(label.getAttribute('aria-live')).toBe('polite');
    });

    it('★ 개행 유지를 바꾸면 문서를 다시 그리게 한다', async () => {
        const onBreaksChanged = vi.fn();
        const sheet = createViewSheet(onBreaksChanged);
        sheet.open();

        const input = sheetOf('view').querySelector<HTMLInputElement>('input[type=checkbox]')!;
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(50);

        expect(getSettings().breaks).toBe(true);
        // 설정이 파서에 들어가므로 다시 그리지 않으면 화면은 그대로다 —
        // 사용자는 스위치만 움직이고 아무 일도 안 일어난 것으로 본다.
        expect(onBreaksChanged).toHaveBeenCalledOnce();
    });

    it('스위치는 글자를 눌러도 켜진다 — 터치 타깃 (10-1절)', () => {
        const sheet = createViewSheet(() => {});
        sheet.open();
        const row = sheetOf('view').querySelector('.setting-row--toggle')!;
        // <label> 로 감싸야 글자까지 누를 수 있다. <div> 면 스위치만 눌린다.
        expect(row.tagName).toBe('LABEL');
    });

    it('back 레이어를 얹고 뗀다', async () => {
        const sheet = createViewSheet(() => {});
        sheet.open();
        expect(hasLayer('view-sheet')).toBe(true);

        expect(await __pressBackForTest()).toBe('view-sheet');
        expect(hasLayer('view-sheet')).toBe(false);
    });

    it('★ 설정을 바꿔도 시트는 열려 있다', async () => {
        const sheet = createViewSheet(() => {});
        sheet.open();

        segOf(t.view.themeDark).click();
        await vi.advanceTimersByTimeAsync(50);

        // 하나 바꿀 때마다 닫히면 여러 개를 시험해 보려는 사람이 매번 다시 열어야 한다.
        expect(sheetOf('view').hidden).toBe(false);
        expect(hasLayer('view-sheet')).toBe(true);
    });
});

describe('★ 두 시트가 서로를 밀어내지 않는다', () => {
    it('레이어 이름이 다르다', async () => {
        const toc = createTocSheet(container, noHandle);
        const view = createViewSheet(() => {});

        toc.open(headings('제목'));
        view.open();

        expect(hasLayer('toc')).toBe(true);
        expect(hasLayer('view-sheet')).toBe(true);

        // 나중에 연 것부터 닫힌다.
        expect(await __pressBackForTest()).toBe('view-sheet');
        expect(await __pressBackForTest()).toBe('toc');
    });
});
