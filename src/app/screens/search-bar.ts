import { pushLayer, removeLayer } from '../router';
import { debounce } from '../../utils/debounce';
import {
    runSearch,
    clearSearch,
    step,
    counterLabel,
    type SearchState,
} from '../../services/doc-search';
import type { RenderHandle } from '../../markdown/render-pipeline';
import { iconButton } from '../icons';
import { t } from '../../i18n';

/**
 * T2 검색 바 — 상단 바를 덮는 인라인 바 (8-6절).
 *
 * ★ 닫히는 경로는 셋뿐이다. ① 닫기 버튼 ② 안드로이드 뒤로가기 ③ 다른 문서를 여는 것.
 *   **어느 경로로 닫혀도 clearSearch() 가 불려야 한다.** 남기면 다음 검색이 어긋난다.
 */

export interface SearchBar {
    /** 바를 연다. ★ 내부에서 renderRest() 를 기다린다 — 안 하면 문서 뒷부분이 안 잡힌다. */
    open(): Promise<void>;
    /** 열려 있으면 닫는다. 문서를 갈아탈 때 반드시 부를 것. */
    close(): void;
    get isOpen(): boolean;
    readonly root: HTMLElement;
}

export function createSearchBar(
    container: HTMLElement,
    getHandle: () => RenderHandle | null,
    /**
     * 열림/닫힘을 알린다. 부르는 쪽이 **상단 바를 감춰야 한다** —
     * ★ 검색 바는 상단 바 '아래 한 줄'이 아니라 상단 바를 **덮는** 것이다(9-1절 T2).
     *   아래에 덧붙이면 검색 중에도 편집·목차 버튼이 눌려서 오작동한다(2026-08-03 실측).
     */
    onToggle?: (open: boolean) => void,
): SearchBar {
    const root = document.createElement('div');
    root.className = 'search-bar app-topbar';
    root.hidden = true;
    root.setAttribute('role', 'search');

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    /*
     * ★ 여기는 초성 안내를 넣지 않는다. 이 바는 세는 칸과 버튼 3개를 함께 이고 있어서
     *   입력칸에 남는 폭이 120px 뿐이다(384px 화면 실측) — 넣어 봐야 잘려서 안 읽힌다.
     *   초성 검색은 시작 화면 검색창이 가르친다. 여기서도 그대로 동작한다(8-5절).
     */
    input.placeholder = t.search.placeholder;
    input.setAttribute('aria-label', t.search.label);
    // ★ maxlength 를 쓰지 마라 — 한글 IME 조합 중 글자가 씹힌다(9-5절).
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;

    const counter = document.createElement('span');
    counter.className = 'search-counter';
    counter.setAttribute('aria-live', 'polite');
    counter.textContent = '0/0';

    const prev = iconButton('up', t.search.previous, () => {
        state = step(state, -1);
        updateCounter();
    });
    const next = iconButton('down', t.search.next, () => {
        state = step(state, 1);
        updateCounter();
    });
    const close = iconButton('close', t.search.close, () => bar.close());

    root.append(input, counter, prev, next, close);

    let state: SearchState = { marks: [], current: -1, truncated: false };
    let opened = false;

    const updateCounter = () => {
        counter.textContent = counterLabel(state);
        const none = state.marks.length === 0;
        prev.disabled = none;
        next.disabled = none;
    };

    // 6번 규칙 — 조합 중에는 돌리지 않는다. compositionend 뒤 120ms 디바운스.
    const rerun = debounce(() => {
        state = runSearch(container, input.value);
        updateCounter();
    }, 120);

    input.addEventListener('input', (e) => {
        if ((e as InputEvent).isComposing) return;
        rerun();
    });
    input.addEventListener('compositionend', () => rerun());
    input.addEventListener('keydown', (e) => {
        // ★ 조합 중인 Enter 는 가로채면 안 된다 — 한글 확정용까지 먹으면 글자가 씹힌다.
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        rerun.flush();
        state = step(state, e.shiftKey ? -1 : 1);
        updateCounter();
    });

    const bar: SearchBar = {
        root,
        get isOpen() {
            return opened;
        },
        async open() {
            if (opened) return;
            opened = true;
            root.hidden = false;
            onToggle?.(true);
            // ★ 여는 함수 안에서 동기적으로 등록한다(9-3절).
            pushLayer('search', () => {
                bar.close();
                return true;
            });
            input.value = '';
            state = { marks: [], current: -1, truncated: false };
            updateCounter();
            input.focus();

            // ★ 1번 규칙. 이걸 빼면 문서 뒷부분이 검색되지 않는다.
            await getHandle()?.renderRest();

            /*
             * ★★ 기다리는 동안 사용자는 이미 치고 있다 — 바가 뜨자마자 친다.
             *   그때 돌아간 검색은 **아직 앞부분만 붙은 DOM** 을 훑은 것이라
             *   뒷부분의 결과가 통째로 빠진 채 굳는다. 큰 문서일수록 오래 걸리므로
             *   (실기기 3.6MB 에서 renderRest 8초) 정확히 그런 문서에서만 어긋난다.
             *   사용자에게는 "검색이 안 된다" 로만 보이고 왜인지는 알 길이 없다.
             *
             *   ★ opened 를 다시 본다 — 기다리는 동안 뒤로가기로 닫혔을 수 있다.
             *     그때 훑으면 이미 걷어낸 <mark> 가 되살아난다.
             */
            if (opened && input.value) {
                rerun.cancel();
                state = runSearch(container, input.value);
                updateCounter();
            }
        },
        close() {
            if (!opened) return;
            opened = false;
            rerun.cancel();
            clearSearch(container); // ★ <mark> 를 반드시 걷어낸다
            removeLayer('search');
            root.hidden = true;
            onToggle?.(false);
            state = { marks: [], current: -1, truncated: false };
        },
    };

    return bar;
}
