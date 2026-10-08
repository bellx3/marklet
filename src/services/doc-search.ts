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
 *
 * ★ 텍스트 노드마다 `parent.closest(SKIP_SELECTOR)` 를 부르지 않는다 (2026-08-06).
 *   closest 는 조상을 타고 올라가며 매번 셀렉터를 맞춰 본다.
 *
 * ★★ **다만 이 바꿈의 효과를 과장하지 마라 — 내가 그랬다.**
 *   데스크톱 크로뮴에서 runSearch 전체를 재고 "0.5~1.5초가 멎는다, 폰이면 3~5배" 라고
 *   적었는데, 갤럭시 S22 울트라에 물려 재 보니 실제는 이랬다(2026-08-06):
 *       500KB 문서(텍스트 노드 38,424 · 요소 21,088)
 *       걷기만 따로:  옛 방식 48.9ms  ·  새 방식 46.4ms   → **1.1배, 사실상 같다**
 *       검색 한 번에 메인 스레드가 멎은 최대 시간: **110ms**
 *   데스크톱 수치는 내 탐침이 **갓 만든 DOM 의 첫 레이아웃까지 떠안은** 값이었다.
 *   실제 앱에서는 문서가 이미 그려진 뒤라 그 비용이 들지 않는다.
 *
 *   그래도 이 형태를 쓰는 이유는 남는다 — 셀렉터를 요소마다 한 번만 맞추는 쪽이
 *   문서가 깊어질수록 안전하고, 코드도 짧다. 하지만 **성능 문제를 고친 것은 아니다.**
 *
 * ★ 요소를 함께 훑으면서 제외 대상은 **FILTER_REJECT** 로 가지를 통째로 잘라 낸다.
 *   그러면 셀렉터는 요소마다 딱 한 번만 맞춰 본다.
 *   (텍스트 노드에는 자식이 없으므로 REJECT 와 SKIP 이 같다.)
 */
function collectTextNodes(container: HTMLElement): Text[] {
    const out: Text[] = [];
    const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    return (node as Element).matches(SKIP_SELECTOR)
                        ? NodeFilter.FILTER_REJECT // 이 아래는 통째로 안 본다
                        : NodeFilter.FILTER_SKIP; // 요소 자체는 결과에 안 넣고 자식만 본다
                }
                return node.nodeValue && node.nodeValue.trim()
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        },
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
    return out;
}

/**
 * 질의를 정규화하고 검색 가능한지 판정한다.
 * @returns null 이면 검색하지 않는다(너무 짧다 / 비었다)
 */
function normalizeQuery(raw: string): { needle: string; choseong: boolean } | null {
    /*
     * ★ 질의만 자모를 모은다(NFC). 맥에서 복사해 붙인 검색어가 분해된 채로 올 수 있다.
     *
     * ★★ **본문에는 하지 않는다.** 정규화는 길이를 바꾸므로(분해된 '마' 3자 → 1자)
     *   변환본의 인덱스를 원문 인덱스로 쓰는 이 코드에서 하이라이트가 어긋난다.
     *   그래서 **본문 자체가 NFD 인 문서는 여전히 안 잡힌다** — 알고 남겨 둔 한계다.
     *   맥은 파일 **이름**을 NFD 로 만들지 내용까지 바꾸지는 않으므로 드물다.
     */
    const q = raw.normalize('NFC').trim();
    if (!q) return null;
    if (isChoseongQuery(q)) {
        // ★ 공백을 지우지 않는다. 지우면 본문 오프셋과 어긋난다.
        const t = q.replace(/\s+/g, '');
        if (t.length < MIN_CHOSEONG_LEN) return null;
        return { needle: lowerSameLength(q), choseong: true };
    }
    // ★ 본문과 **같은 규칙**으로 낮춘다. 한쪽만 İ 를 풀면 서로 안 맞는다.
    return { needle: lowerSameLength(q), choseong: false };
}

/**
 * ★★★ 길이를 지키는 소문자 변환 (2026-08-06).
 *
 *   `String.prototype.toLowerCase()` 는 **길이를 보존하지 않는다.**
 *   BMP 전체를 훑어 확인한 결과 딱 하나가 그렇다:
 *       U+0130  İ (터키어 대문자 I)  →  'i̇'  (1자 → 2자)
 *
 *   이 앱은 소문자 변환본에서 찾은 인덱스를 **원문 인덱스로 그대로** 쓴다.
 *   그래서 문서에 `İ` 가 하나만 있어도 그 뒤 모든 오프셋이 한 칸씩 밀린다:
 *       'İstanbul 마크다운 문서' 에서 '마크다운' 을 찾으면 → '크다운 ' 이 칠해진다
 *       'İstanbul 마크다운'    처럼 끝에서 걸리면 →
 *           IndexSizeError: offset 14 is larger than the node's length (13)
 *       (2026-08-06 실측. 겹치는 일치 때와 **똑같은 신호**로 검색이 통째로 죽는다.)
 *
 *   터키 지명·인명 하나면 걸린다 — AI 가 쓴 문서에 İstanbul·İzmir·Türkiye 는 흔하다.
 *
 * ★ 길이가 달라지는 글자는 **원문 그대로 둔다.** 그러면 `i` 로 `İ` 를 찾지 못하게
 *   되지만, 터키어에서 İ 와 i 는 애초에 다른 글자다. 자리가 어긋나는 것보다 낫다.
 * ★ 거의 모든 문자열은 첫 줄에서 끝난다 — 비용은 길이 비교 하나다.
 */
function lowerSameLength(s: string): string {
    const lower = s.toLowerCase();
    if (lower.length === s.length) return lower;

    let out = '';
    for (const ch of s) {
        // ★ 코드 포인트 단위로 돈다. 서로게이트 쌍을 반으로 자르면 안 된다.
        const lo = ch.toLowerCase();
        out += lo.length === ch.length ? lo : ch;
    }
    return out;
}

/**
 * 한글 음절 1자는 초성 1자로 바뀌므로 **문자 오프셋이 그대로 보존된다.**
 * 그래서 초성 변환본에서 찾은 인덱스를 원문 인덱스로 그대로 쓸 수 있다.
 * 이 성질이 깨지면(예: 공백 제거, 위 İ) 하이라이트 위치가 어긋난다.
 */
function haystackOf(text: string, choseong: boolean): string {
    return choseong ? toChoseong(text) : lowerSameLength(text);
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
         * ★★ 이 앱은 변환본의 인덱스를 **원문 인덱스로 그대로** 쓴다. 그 전제가 깨진
         *   노드는 자리가 어긋나고, 끝에서 걸리면 Range 가 터져 검색이 통째로 죽는다.
         *   위 두 변환은 길이를 지키도록 만들었지만, 만에 하나 어긋나면
         *   **잘못 칠하느니 이 노드를 건너뛴다.** 안전망이자 전제를 적어 두는 자리다.
         */
        if (hay.length !== original.length) continue;

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
    /*
     * ★ normalize() 를 빼면 텍스트 노드가 계속 쪼개져 다음 검색이 단어를 놓친다.
     *   ("마크다운" 이 "마크" + "다운" 두 노드로 남으면 영영 안 잡힌다.)
     *
     * ★ 표시마다 부르지 않고 부모를 모아 한 번씩만 부른다. normalize() 는 그 요소의
     *   자식을 전부 훑으므로, 한 문단에 표시가 여럿일 때 같은 문단을 그만큼 다시 훑게 된다.
     *   ★★ 표시가 문단마다 하나씩 흩어져 있으면 **차이가 없다** — 실기기에서 그렇게 나왔다.
     *     이득은 '한 문단에 여러 개' 일 때만 생긴다. 손해는 없으니 이 형태를 쓴다.
     */
    const parents = new Set<Element>();
    for (const mark of Array.from(marks)) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
        parents.add(parent as Element);
    }
    for (const parent of parents) parent.normalize();
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
