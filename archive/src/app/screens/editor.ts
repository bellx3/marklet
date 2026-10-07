import { scheduleDraftSave, flushDraft } from '../../services/draft';
import { t } from '../../i18n';

/**
 * 편집기 (9-5절) — 한글 IME 가 핵심이다.
 *
 * ★ 에디터 라이브러리를 쓰지 않는다. 순수 <textarea> 다.
 *   CodeMirror 6·Monaco 의 2026년 안드로이드 IME 상태를 확인하지 못했고,
 *   한글 조합이 깨지면 이 앱의 두 번째 차별점이 통째로 무너진다.
 *   <textarea> 는 OS 가 IME 를 직접 다루므로 그 위험이 없다.
 */

export interface EditorHandle {
    getValue(): string;
    setValue(v: string): void;
    isDirty(): boolean;
    markSaved(): void;
    destroy(): void;
}

export function createTextArea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.id = 'editor';
    ta.className = 'editor-area';
    ta.spellcheck = false;
    ta.autocapitalize = 'off';
    ta.autocomplete = 'off';
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('aria-label', t.editor.title);
    // ★ maxlength 를 쓰지 마라. 한글 IME 에서 조합 중인 글자도 길이에 포함되어
    //   한도에 닿으면 마지막 글자만 계속 바뀐다.
    return ta;
}

export function createEditor(ta: HTMLTextAreaElement, uri: string, initial: string): EditorHandle {
    ta.value = initial;
    let savedValue = initial;
    let composing = false;

    const onInput = () => {
        // 조합 중에도 초안은 저장한다(중간 글자가 섞여도 초안이니 괜찮다).
        // ★ 조합 중에 ta.value 를 프로그램으로 바꾸면 안 된다 — 글자가 씹힌다.
        scheduleDraftSave(uri, ta.value);
    };

    const onCompositionStart = () => {
        composing = true;
    };
    const onCompositionEnd = () => {
        composing = false;
        onInput();
    };

    ta.addEventListener('input', onInput);
    ta.addEventListener('compositionstart', onCompositionStart);
    ta.addEventListener('compositionend', onCompositionEnd);

    const unbindKeyboard = bindKeyboardInset(ta);

    return {
        getValue: () => ta.value,
        setValue(v) {
            // ★ 조합 중에는 절대 덮어쓰지 않는다.
            if (composing) return;
            ta.value = v;
            savedValue = v;
        },
        isDirty: () => ta.value !== savedValue,
        markSaved() {
            savedValue = ta.value;
        },
        destroy() {
            void flushDraft();
            ta.removeEventListener('input', onInput);
            ta.removeEventListener('compositionstart', onCompositionStart);
            ta.removeEventListener('compositionend', onCompositionEnd);
            unbindKeyboard();
        },
    };
}

/**
 * 키보드가 올라온 만큼 편집 영역을 줄인다.
 * 전체 화면 textarea 이므로 scrollIntoView 가 아니라 '높이를 줄이는' 쪽이 맞다 —
 * 높이가 줄면 브라우저가 캐럿을 알아서 보이게 유지한다.
 */
function bindKeyboardInset(ta: HTMLTextAreaElement): () => void {
    const vv = window.visualViewport;
    if (!vv) return () => {};

    const onResize = () => {
        const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    onResize();

    return () => {
        vv.removeEventListener('resize', onResize);
        vv.removeEventListener('scroll', onResize);
        document.documentElement.style.setProperty('--kb-inset', '0px');
        void ta; // 참조 유지 (noUnusedParameters)
    };
}
