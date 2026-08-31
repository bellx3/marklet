/**
 * 넓은 블록(디스플레이 수식·표)을 화면 폭에 맞춰 줄인다.
 *
 * 여태 이것들은 '자기 상자 안에서 가로 스크롤' 로만 처리했다. 문서 전체가 밀려나는
 * 사고는 그걸로 막았지만(markdown.css 의 .katex-display 주석 참고), 읽는 쪽에서는
 * 문단마다 손가락을 좌우로 움직여야 해서 여전히 불편하다.
 *
 * 그래서 한 단계를 더 둔다.
 *   ① 표는 CSS 가 먼저 셀을 접어서 폭을 맞춘다(markdown.css, width:100%).
 *   ② 그래도 넘치면 여기서 글자 크기를 줄여 상자 안에 넣는다.
 *   ③ FLOOR 아래로는 줄이지 않는다 — 그 밑은 맞춰 봐야 못 읽는다. 남는 만큼은
 *      기존대로 가로 스크롤이 받는다(스크롤 CSS 를 지우면 안 되는 이유다).
 *
 * ★ 측정은 **화면에 들어온 것만** 한다.
 *   본문 청크에는 content-visibility:auto 가 걸려 있다(render-pipeline). 화면 밖
 *   블록의 scrollWidth 를 읽으면 그 최적화를 통째로 깨고 문서 전체 레이아웃을
 *   강제한다 — 2.5MB 문서에서 그건 몇 초짜리 정지다. 아래 bindFitToWidth 가
 *   청크 단위로 먼저 걸러내는 이유가 이것이다.
 */

/** 이 배율 밑으로는 줄이지 않는다. 0.55 면 16px 본문이 8.8px — 더 줄이면 못 읽는다. */
const FLOOR = 0.55;

/** 1px 안쪽 차이는 반올림 오차다. 이걸로 줄이면 의미 없이 글자만 작아진다. */
const SLACK = 1;

/** 표는 글자를 줄이면 셀이 다시 접혀서 폭이 비례해서 줄지 않는다. 그래서 두 번 본다. */
const PASSES = 2;

const SELECTOR = '.katex-display, .table-scroll';

/** 상자(스크롤을 받는 쪽)에 대해 실제로 크기를 줄일 대상. 표는 상자가 래퍼다. */
function contentOf(box: HTMLElement): HTMLElement | null {
    if (box.classList.contains('table-scroll')) return box.querySelector('table');
    return box;
}

/**
 * 한 블록을 상자 폭에 맞춘다. 이미 맞으면 아무것도 하지 않는다.
 * 항상 '원래 크기로 되돌리고 다시 잰다' — 회전·글꼴 크기 변경 뒤에도 맞아야 하고,
 * 화면이 넓어졌는데 줄어든 채로 남는 일이 없어야 한다.
 */
export function fitBlock(box: HTMLElement): void {
    const content = contentOf(box);
    if (!content) return;

    content.style.fontSize = '';

    const avail = box.clientWidth;
    if (avail <= 0) return; // 아직 레이아웃 전이다. 나중에 다시 불린다.

    /*
     * 줄인 뒤에도 '원래 크기' 를 알아야 다음번에 되돌릴 수 있다. 그래서 배율(em·%)이
     * 아니라 절대 px 로 건다 — 위에서 인라인 값을 지우고 읽었으니 이건 CSS 가 준 값이다.
     * (getComputedStyle 이 값을 못 주는 환경 — 스타일시트 없는 jsdom — 은 16px 로 본다)
     */
    const basePx = parseFloat(getComputedStyle(content).fontSize) || 16;

    let scale = 1;
    for (let i = 0; i < PASSES; i++) {
        const need = content.scrollWidth;
        if (need <= avail + SLACK) break;

        const next = Math.max(FLOOR, scale * (avail / need));
        if (next >= scale) break; // 더 줄일 여지가 없다(바닥에 닿았다)
        scale = next;
        content.style.fontSize = `${(basePx * scale).toFixed(2)}px`;
    }
}

/** 화면 위아래로 이만큼 여유를 둔다. 스크롤 중에 글자가 줄어드는 게 보이면 안 된다. */
const MARGIN = 400;

/**
 * 컨테이너에 한 번만 걸어 둔다. 이후 붙는 청크·나중에 그려지는 표에도 적용된다.
 * 반환값을 부르면 관찰을 멈춘다.
 *
 * ★ IntersectionObserver 를 쓰지 않는다.
 *   처음에는 그걸로 짰는데 **콜백이 오지 않는 환경이 있었다**(2026-08-31, 브라우저
 *   패널이 숨은 채로 도는 프리뷰). 같은 페이지에서 rAF·스크롤 이벤트는 정상이었다.
 *   화면에 못 나오는 기능은 검증할 수도 없다. 그래서 스크롤 + rAF 로 직접 훑는다.
 *
 * ★ 훑을 때 **청크(container 의 직계 자식) 단위로 먼저 걸러낸다.**
 *   화면 밖 청크에는 content-visibility:auto 가 걸려 있다(render-pipeline). 그 안의
 *   표·수식 위치를 물어보는 순간 그 최적화가 깨지고 문서 전체 레이아웃이 강제된다.
 *   청크 자신의 사각형은 containIntrinsicSize 로 답할 수 있어 속을 펴지 않는다.
 */
export function bindFitToWidth(container: HTMLElement): () => void {
    /** 이미 맞춘 블록 → 그때의 상자 폭. 폭이 그대로면 다시 재지 않는다(회전하면 달라진다). */
    let done = new WeakMap<HTMLElement, number>();
    /** 마지막으로 훑을 때의 본문 글자 크기. 이게 바뀌면 위 기록은 전부 무효다. */
    let lastFont = '';
    let scheduled = false;

    const sweep = (): void => {
        scheduled = false;

        /*
         * ★ 글꼴 크기(A+ / A−)는 상자 폭을 바꾸지 않는다. 폭만 보고 건너뛰면
         *   A+ 뒤에 넘치는 표가 그대로 남고, A− 뒤에는 줄어든 채로 남는다.
         *   설정은 <html> 의 --md-font-size 로 들어오므로 계산값으로 알아챈다.
         */
        const font = getComputedStyle(container).fontSize;
        if (font !== lastFont) {
            lastFont = font;
            done = new WeakMap();
        }

        const view = window.innerHeight || document.documentElement.clientHeight || 0;
        for (const chunk of Array.from(container.children) as HTMLElement[]) {
            const r = chunk.getBoundingClientRect();
            if (r.bottom < -MARGIN || r.top > view + MARGIN) continue;
            for (const box of Array.from(chunk.querySelectorAll<HTMLElement>(SELECTOR))) {
                const width = box.clientWidth;
                if (width > 0 && done.get(box) === width) continue;
                fitBlock(box);
                done.set(box, box.clientWidth);
            }
        }
    };

    /*
     * ★ rAF 와 타이머를 **둘 다** 건다. 먼저 오는 쪽이 이기고 나머지는 scheduled 로 막힌다.
     *
     *   rAF 하나만 걸면 브라우저가 그리기를 멈춘 동안(숨은 탭·정지된 WebView) 영영
     *   안 온다 — 2026-08-31 프리뷰에서 실제로 rAF 도 IntersectionObserver 도 한 번도
     *   불리지 않는 것을 확인했다. 그동안 표는 줄지 않은 채로 남는다.
     *   평소에는 rAF 가 먼저 와서 프레임에 맞춰 도니 타이머 쪽은 낭비가 아니다.
     */
    const schedule = (): void => {
        if (scheduled) return;
        scheduled = true;
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sweep);
        setTimeout(sweep, 100);
    };

    schedule();

    // 청크가 붙거나 Mermaid 가 코드 블록을 SVG 로 갈아 끼우면 대상이 늘어난다.
    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });

    /*
     * 글꼴 크기 설정은 <html> 의 style 로 들어온다 — container 밖이라 위 관찰자가 못 본다.
     * 본문을 건드리지 않고 A+ 를 누른 그 화면에서 바로 맞으려면 여기도 봐야 한다.
     */
    const rootMo = new MutationObserver(schedule);
    rootMo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    /*
     * 스크롤은 **capture 로 document 에 건다.** 본문은 window 가 아니라 안쪽 상자가
     * 스크롤하는데 scroll 이벤트는 버블하지 않는다 — capture 여야 여기까지 온다.
     */
    const onScroll = (): void => schedule();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('orientationchange', onScroll);

    return () => {
        mo.disconnect();
        rootMo.disconnect();
        document.removeEventListener('scroll', onScroll, { capture: true });
        window.removeEventListener('resize', onScroll);
        window.removeEventListener('orientationchange', onScroll);
    };
}
