import { toChoseong, isChoseongQuery } from '../utils/hangul';

/**
 * 문서 내 검색 (8-6절 · M18 · M19 · T2).
 *
 * 확정 규칙 7개
 *   1. 검색 전에 반드시 handle.renderRest() 를 기다린다. 청크가 안 붙어 있으면
 *      문서 뒷부분이 DOM 에 없어서 '없음'으로 나온다.
 *   2. 검색 대상은 렌더된 DOM 의 텍스트 노드. 코드 블록 안도 포함한다.
 *      ★ KaTeX 는 같은 수식을 HTML 과 MathML 로 두 번 넣는다. .katex-mathml 을 건너뛴다.
 *   3. 질의가 초성 자모로만 이뤄지면 초성 모드, 아니면 대소문자 무시 부분 문자열.
 *   4. ★ 본문 초성 모드는 최소 2자다. 1자는 오탐이 폭증한다.
 *   5. 하이라이트는 innerHTML 을 다시 쓰지 않는다. Range 로 <mark> 만 끼운다.
 *      재작성하면 이미 그린 Mermaid SVG·각주 앵커·체크박스 상태가 날아간다.
 *   6. 조합(isComposing) 중에는 검색하지 않는다 — 붙이는 쪽(viewer.ts)의 책임이다.
 *   7. 일치가 MAX_MATCHES 를 넘으면 멈추고 UI 에 그 사실을 표시한다. 조용히 자르지 마라.
 */

/** 하이라이트 상한. 넘으면 UI 가 "500+" 로 표시한다. */
export const MAX_MATCHES = 500;
/** 본문 초성 검색 최소 길이 (0-2절 판정) */
export const MIN_CHOSEONG_LEN = 2;

const SKIP_SELECTOR = '.katex-mathml, annotation, svg, script, style, .md-block-label';

export interface SearchState {
    /** 화면에 끼운 <mark> 들. 순서 = 문서 순서 */
    marks: HTMLElement[];
    /** 0-based. 아무것도 안 잡혔으면 -1 */
    current: number;
    /** MAX_MATCHES 에서 잘렸는가 */
    truncated: boolean;
}

const EMPTY: SearchState = { marks: [], current: -1, truncated: false };

/**
 * 컨테이너 안의 텍스트 노드를 문서 순서로 모은다.
 * 제외 대상(SKIP_SELECTOR) 안에 있는 노드는 건너뛴다.
 */
function collectTextNodes(container: HTMLElement): Text[] {
    const out: Text[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            const parent = (node as Text).parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
    return out;
}

/**
 * 질의를 정규화하고 검색 가능한지 판정한다.
 * @returns null 이면 검색하지 않는다(너무 짧다 / 비었다)
 */
function normalizeQuery(raw: string): { needle: string; choseong: boolean } | null {
    const q = raw.trim();
    if (!q) return null;
    if (isChoseongQuery(q)) {
        // ★ 공백을 지우지 않는다. 지우면 본문 오프셋과 어긋난다.
        //   (8-5절 matchesName 은 짧은 파일 이름이라 공백을 지워도 안전하다.)
        const t = q.replace(/\s+/g, '');
        if (t.length < MIN_CHOSEONG_LEN) return null;
        return { needle: q.toLowerCase(), choseong: true };
    }
    return { needle: q.toLowerCase(), choseong: false };
}

/**
 * 한글 음절 1자는 초성 1자로 바뀌므로 **문자 오프셋이 그대로 보존된다.**
 * 그래서 초성 변환본에서 찾은 인덱스를 원문 인덱스로 그대로 쓸 수 있다.
 * 이 성질이 깨지면(예: 공백 제거) 하이라이트 위치가 어긋난다.
 */
function haystackOf(text: string, choseong: boolean): string {
    return choseong ? toChoseong(text) : text.toLowerCase();
}

/**
 * 검색을 실행하고 <mark> 를 끼운다.
 * ★ 호출 전에 await handle.renderRest() 를 끝내 둘 것.
 */
export function runSearch(container: HTMLElement, rawQuery: string): SearchState {
    clearSearch(container);

    const q = normalizeQuery(rawQuery);
    if (!q) return { ...EMPTY };

    const nodes = collectTextNodes(container);
    const marks: HTMLElement[] = [];
    let truncated = false;

    outer: for (const node of nodes) {
        const original = node.nodeValue ?? '';
        const hay = haystackOf(original, q.choseong);

        /*
         * 한 노드 안의 모든 일치를 뒤에서부터 처리한다.
         * 앞에서부터 자르면 splitText 가 오프셋을 밀어 버린다.
         *
         * ★★★ 다음 자리를 `i + 1` 로 잡지 마라. **겹치는 일치**가 생긴다.
         *   `....` 에서 `..` 를 찾으면 0·1·2 가 다 잡힌다. 그런데 뒤에서부터
         *   surroundContents 를 하면 노드가 그 자리에서 잘려 짧아지므로,
         *   앞쪽 일치의 끝이 이미 없는 자리를 가리킨다:
         *       DOMException: offset 5 is larger than the node's length (4)
         *   검색이 통째로 터지고 사용자는 왜 안 되는지 알 방법이 없다(2026-08-06 실측).
         *
         *   드문 입력이 아니다 — AI 문서의 말줄임 `...`, 표 구분 `----`,
         *   한국어 `ㅋㅋㅋ`, 그리고 **초성 검색 `ㄱㄱ` 이 `기관공` 같은 평범한 말**에
         *   걸리면 바로 밟는다.
         *
         * ★ 겹치지 않게 세는 것이 브라우저 Ctrl+F 와도 같은 셈법이다.
         */
        const hits: number[] = [];
        for (
            let i = hay.indexOf(q.needle);
            i >= 0;
            i = hay.indexOf(q.needle, i + q.needle.length)
        ) {
            hits.push(i);
            if (hits.length + marks.length >= MAX_MATCHES) {
                truncated = true;
                break;
            }
        }
        if (hits.length === 0) continue;

        // ★★ 이 노드에서 만든 것만 따로 모은다.
        //   전체 marks 에 바로 unshift 하면 **뒤에 나온 노드가 앞으로 간다** —
        //   배열이 블록 단위로 뒤집혀서 [다음 결과 ∨] 가 문서를 거꾸로 훑는다.
        //   (한 노드 안에서는 뒤에서부터 만들어야 splitText 가 오프셋을 밀지 않는다.
        //    그래서 '노드 안은 unshift, 노드 사이는 push' 두 단이 필요하다.)
        const nodeMarks: HTMLElement[] = [];
        for (let k = hits.length - 1; k >= 0; k--) {
            const start = hits[k];
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + q.needle.length);

            const mark = document.createElement('mark');
            mark.className = 'md-hit';
            // 단일 텍스트 노드 안의 범위라 surroundContents 가 항상 성공한다.
            range.surroundContents(mark);
            nodeMarks.unshift(mark); // 뒤에서부터 만들었으므로 앞에 넣어 노드 안 순서를 맞춘다
        }
        marks.push(...nodeMarks);
        if (truncated) break outer;
    }

    const state: SearchState = { marks, current: marks.length ? 0 : -1, truncated };
    if (state.current >= 0) focusMatch(state, 0);
    return state;
}

/** <mark> 를 걷어내고 쪼개진 텍스트 노드를 다시 합친다. */
export function clearSearch(container: HTMLElement): void {
    const marks = container.querySelectorAll<HTMLElement>('mark.md-hit');
    for (const mark of Array.from(marks)) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
        // ★ normalize() 를 빼면 텍스트 노드가 계속 쪼개져 다음 검색이 단어를 놓친다.
        //   ("마크다운" 이 "마크" + "다운" 두 노드로 남으면 영영 안 잡힌다.)
        (parent as Element).normalize();
    }
}

/** 다음/이전. 끝에서 처음으로 돈다. */
export function step(state: SearchState, delta: 1 | -1): SearchState {
    if (state.marks.length === 0) return state;
    const n = state.marks.length;
    const next = (state.current + delta + n) % n;
    focusMatch(state, next);
    return { ...state, current: next };
}

function focusMatch(state: SearchState, index: number): void {
    state.marks.forEach((m, i) => m.classList.toggle('is-current', i === index));
    const target = state.marks[index];
    if (!target) return;
    // content-visibility: auto 인 청크 안이어도 scrollIntoView 는 레이아웃을 강제해 동작한다.
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    // 스크롤만 하면 스크린 리더는 이동을 모른다 (10-3절 목차 점프와 같은 처리)
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
}

/** 상단 바에 표시할 문자열. 0건과 상한 초과를 구분한다. */
export function counterLabel(state: SearchState): string {
    if (state.marks.length === 0) return '0/0';
    const total = state.truncated ? `${MAX_MATCHES}+` : String(state.marks.length);
    return `${state.current + 1}/${total}`;
}
