import { Overlay, createSheet } from '../overlay';
import { t } from '../../i18n';
import {
    FONT_STEPS,
    clampStep,
    getSettings,
    updateSettings,
    type AppSettings,
} from '../../services/settings';

/**
 * T3 보기 설정 시트 — 테마 · 글자 크기 · 개행 유지.
 * 설정 화면(S4)과 같은 항목을 다루지만, 문서를 보면서 바로 바꾸기 위한 축약판이다.
 */
export interface ViewSheet {
    open(): void;
    close(): void;
    destroy(): void;
}

export function createViewSheet(onBreaksChanged: () => void): ViewSheet {
    const { root, body } = createSheet({ title: t.view.title, id: 'view' });
    (document.querySelector('#overlay-root') ?? document.body).appendChild(root);
    const overlay = new Overlay(root, 'view-sheet');

    root.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t === root || t.closest('[data-act="close"]')) overlay.hide();
    });

    // ── 테마
    const themeRow = createRow(t.view.theme);
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
        b.addEventListener('click', () => void updateSettings({ theme: value }).then(sync));
        themeGroup.appendChild(b);
        return { b, value };
    });
    themeRow.appendChild(themeGroup);

    // ── 글자 크기
    const sizeRow = createRow(t.view.fontSize);
    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'seg';
    const smaller = stepBtn('A−', t.view.smaller, -1);
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'seg-label';
    sizeLabel.setAttribute('aria-live', 'polite');
    const bigger = stepBtn('A+', t.view.bigger, +1);
    sizeGroup.append(smaller, sizeLabel, bigger);
    sizeRow.appendChild(sizeGroup);

    // ── 개행 유지 (6-10절)
    const breaksRow = createToggleRow(t.view.breaks, t.view.breaksHint);
    breaksRow.input.addEventListener('change', () => {
        void updateSettings({ breaks: breaksRow.input.checked }).then(() => {
            sync();
            // 설정이 파서에 들어가므로 문서를 다시 그려야 반영된다.
            onBreaksChanged();
        });
    });

    body.append(themeRow, sizeRow, breaksRow.row);

    function stepBtn(label: string, aria: string, delta: number): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-item';
        b.textContent = label;
        b.setAttribute('aria-label', aria);
        b.addEventListener('click', () => {
            void updateSettings({ fontStep: clampStep(getSettings().fontStep + delta) }).then(sync);
        });
        return b;
    }

    function sync(): void {
        const s = getSettings();
        for (const { b, value } of themeBtns) {
            const on = s.theme === value;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-checked', String(on));
        }
        const step = clampStep(s.fontStep);
        sizeLabel.textContent = `${FONT_STEPS[step]}px`;
        smaller.disabled = step === 0;
        bigger.disabled = step === FONT_STEPS.length - 1;
        breaksRow.input.checked = s.breaks;
    }

    return {
        open() {
            sync();
            overlay.show();
        },
        close: () => overlay.hide(),
        destroy() {
            overlay.hide();
            root.remove();
        },
    };
}

function createRow(label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const l = document.createElement('span');
    l.className = 'setting-label';
    l.textContent = label;
    row.appendChild(l);
    return row;
}

/** 스위치 한 줄. label 로 감싸서 글자를 눌러도 켜지게 한다(터치 타깃, 10-1절). */
export function createToggleRow(
    label: string,
    hint?: string,
): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('label');
    row.className = 'setting-row setting-row--toggle';

    const text = document.createElement('span');
    text.className = 'setting-text';

    const l = document.createElement('span');
    l.className = 'setting-label';
    l.textContent = label;
    text.appendChild(l);

    if (hint) {
        const h = document.createElement('span');
        h.className = 'setting-hint';
        h.textContent = hint;
        text.appendChild(h);
    }

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch';

    row.append(text, input);
    return { row, input };
}
