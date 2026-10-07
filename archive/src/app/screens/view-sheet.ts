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
            // 끝에 닿았으면 아무 일도 하지 않는다. 버튼은 계속 초점을 받는다(setLimit 주석).
            if (b.getAttribute('aria-disabled') === 'true') return;
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
        setStepLimit(smaller, step === 0);
        setStepLimit(bigger, step === FONT_STEPS.length - 1);
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

/**
 * 글자 크기 단추가 끝에 닿았음을 알린다.
 *
 * ★★ `disabled` 를 쓰지 마라. **초점을 가진 버튼을 disabled 로 만들면 브라우저가
 *   초점을 `<body>` 로 되돌린다.** A− 를 끝까지 누른 사람은 그 순간 시트 밖으로
 *   튕겨 나간다 — 토크백에서는 다음 스와이프가 화면 맨 위에서 다시 시작하고,
 *   키보드에서는 탭이 문서 처음으로 간다(2026-08-06 실측).
 *
 * ★ 설정 화면(S4)에도 같은 단추가 있다. 한쪽만 고치지 마라.
 */
export function setStepLimit(btn: HTMLButtonElement, atLimit: boolean): void {
    btn.setAttribute('aria-disabled', String(atLimit));
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
