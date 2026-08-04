import { sanitizeMermaidSvg } from './sanitize';
import { t } from '../i18n';

/**
 * Mermaid 지연 렌더.
 *
 * 구현 규칙 7개 (01_제품_결정서.md 11.1절 / 02 6-12절). 하나도 빼지 마라.
 *   1. mermaid 를 정적 import 하지 않는다. 반드시 동적 import() 로 별도 청크.
 *   2. 코드 블록을 먼저 그린다. 본문은 Mermaid 로딩과 무관하게 즉시 읽힌다.
 *   3. 문서에 mermaid 블록이 하나라도 있을 때만 청크를 로드한다.
 *   4. securityLevel: 'strict' 고정. 'loose' 로 바꾸지 마라 — 남이 만든 .md 를 여는 앱이다.
 *   5. 생성된 SVG 도 DOMPurify 를 통과시킨다.
 *   6. 로드 실패 · 문법 오류 · 5초 타임아웃 → 코드 블록을 그대로 두고 라벨만 바꾼다.
 *   7. SVG 는 표와 같은 취급 — 넘치면 가로 스크롤.
 */

/** 문서에 mermaid 코드펜스가 있는지 값싸게 판정. 없으면 청크를 아예 안 받는다. */
export function looksLikeMermaid(source: string): boolean {
    return /^[ \t]*```[ \t]*mermaid\b/im.test(source);
}

/** 한 블록당 상한. 넘으면 코드 블록으로 남긴다(제품 결정서 11.1의 5초 규칙). */
const RENDER_TIMEOUT_MS = 5000;

let mermaidApi: typeof import('mermaid').default | null = null;
let loadFailed = false;

/**
 * 청크를 받아 초기화한다. 두 번 불러도 한 번만 로드된다.
 * ★ 실패를 던지지 않는다. null 을 돌려주고 호출자는 코드 블록을 그대로 둔다.
 */
async function ensureMermaid(): Promise<typeof import('mermaid').default | null> {
    if (mermaidApi || loadFailed) return mermaidApi;
    try {
        const mod = await import('mermaid');
        const api = mod.default;
        api.initialize({
            startOnLoad: false, // ★ 우리가 직접 부른다. true 면 DOM 을 마음대로 훑는다
            securityLevel: 'strict', // ★ 절대 'loose' 로 바꾸지 마라
            theme: isDark() ? 'dark' : 'default',
            fontFamily: 'inherit',
            // ★ htmlLabels: false — 라벨을 <foreignObject> 안 HTML 이 아니라 SVG <text> 로 그린다.
            //   기본값(true)이면 라벨이 DOMPurify 를 통과하지 못해 **도형만 남고 글자가 전부
            //   사라진다**(2026-08-03 실기기 실측: foreignObject 17개가 내용 없이 껍데기만 남음).
            //   원인은 DOMPurify 가 SVG 문자열을 HTML 파서로 읽어 SVG→XHTML 네임스페이스 전환이
            //   깨지는 것이다. 살균기를 더 여는 것보다 문제 자체를 없애는 쪽이 낫다 —
            //   이러면 우리 SVG 에 HTML 이 아예 섞이지 않는다.
            //   대가: 라벨 안에서 굵게/링크 같은 HTML 서식을 못 쓴다. 다이어그램에 필요 없다.
            htmlLabels: false,
            flowchart: { useMaxWidth: false, htmlLabels: false },
            sequence: { useMaxWidth: false },
            class: { useMaxWidth: false, htmlLabels: false },
        });
        mermaidApi = api;
        return api;
    } catch (err) {
        console.error('Mermaid 로드 실패:', err);
        loadFailed = true;
        return null;
    }
}

function isDark(): boolean {
    return document.documentElement.dataset.theme === 'dark';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

/**
 * 렌더가 끝난 컨테이너의 mermaid 블록을 SVG 로 바꾼다.
 * 호출 시점: renderProgressive 의 handle.complete 이후 (본문이 이미 읽히는 상태).
 * ★ 이 함수는 절대 throw 하지 않는다. 실패는 블록 단위로 흡수한다.
 */
export async function upgradeMermaidBlocks(container: HTMLElement): Promise<void> {
    const blocks = Array.from(
        container.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-state="pending"]'),
    );
    if (blocks.length === 0) return;

    const api = await ensureMermaid();
    if (!api) {
        for (const b of blocks) {
            fail(b, t.mermaid.loadFailed, b.dataset.mermaidSrc ?? '');
        }
        return;
    }

    let seq = 0;
    for (const block of blocks) {
        const src = block.dataset.mermaidSrc ?? '';
        block.dataset.mermaidState = 'working';
        const id = `mmd-${Date.now()}-${seq++}`;
        try {
            // ★ 1단계 — 그리기 전에 문법을 먼저 검사한다.
            //   suppressErrors:true 면 던지는 대신 false 를 돌려준다. 이렇게 하면
            //   ① 문법 오류와 렌더 중 크래시를 구분할 수 있고
            //   ② 실패 시 mermaid 가 DOM 에 임시 노드를 남기지 않는다.
            const parsed = await withTimeout(
                api.parse(src, { suppressErrors: true }),
                RENDER_TIMEOUT_MS,
            );
            if (!parsed) {
                fail(block, syntaxMessage(src), src);
                continue;
            }

            // 2단계 — 실제로 그린다. id 는 문서 안에서 유일해야 한다.
            const { svg } = await withTimeout(api.render(id, src), RENDER_TIMEOUT_MS);

            const holder = document.createElement('div');
            holder.className = 'mermaid-svg';
            // ★ mermaid 출력도 그대로 믿지 않는다. 단, 본문용 sanitize() 가 아니라
            //   SVG 전용 설정을 쓴다 — 본문용은 <style> 과 <foreignObject> 를 지워서
            //   다이어그램이 통째로 안 보이게 만든다(sanitize.ts 주석 참조).
            holder.innerHTML = sanitizeMermaidSvg(svg);

            // 표와 같은 취급: 넘치면 가로 스크롤 + 스크린 리더가 인지할 수 있게
            holder.tabIndex = 0;
            holder.setAttribute('role', 'img');
            holder.setAttribute('aria-label', mermaidAriaLabel(src));

            const pre = block.querySelector('pre');
            pre?.replaceWith(holder);
            const label = block.querySelector('.md-block-label');
            label?.remove();
            block.dataset.mermaidState = 'done';
        } catch (err) {
            // 어떤 이유든 결과는 같다 — 코드 블록을 그대로 둔다. 다만 이유는 알려 준다.
            const timedOut = err instanceof Error && err.message === 'timeout';
            fail(block, timedOut ? t.mermaid.tooSlow : t.mermaid.drawFailed(firstLine(err)), src);
        } finally {
            // mermaid 는 실패하면 임시 노드를 body 에 남길 수 있다. 매번 치운다.
            // 안 치우면 화면 어딘가에 깨진 도형이 떠 있거나 다음 렌더의 id 가 충돌한다.
            removeOrphan(id);
            removeOrphan(`d${id}`);
        }
        // 블록 사이에서 한 프레임 양보한다. 큰 다이어그램이 여러 개면 화면이 멈춘다.
        await new Promise((r) => setTimeout(r, 0));
    }
}

/**
 * mermaid 가 body 에 남긴 임시 노드만 지운다.
 *
 * ★★ document.getElementById(id) 를 그냥 쓰면 안 된다. 2026-08-03 에 이걸로 사고를 냈다.
 *   api.render(id, src) 가 돌려주는 SVG 문자열에는 **우리가 넘긴 그 id 가 그대로 들어 있다.**
 *   그 SVG 를 DOM 에 넣은 뒤 getElementById(id).remove() 를 부르면
 *   **방금 넣은 우리 다이어그램이 지워진다.** 상태는 'done' 인데 화면은 빈 채로 남는다.
 *
 *   mermaid 의 임시 노드는 body 의 '직계 자식'으로 붙으므로 거기만 노린다.
 */
function removeOrphan(id: string): void {
    for (const el of Array.from(document.body.children)) {
        if (el.id === id) el.remove();
    }
}

/**
 * 문법 검사에서 걸렸을 때의 안내.
 * 첫 줄의 다이어그램 종류를 보고 "우리가 모르는 종류"와 "문법 오류"를 구분해 준다.
 * AI 가 만든 문서는 최신 종류(예: block-beta)를 쓰는 경우가 있는데, 그건 사용자가
 * 고칠 수 있는 문제가 아니라 "이 앱이 아직 못 그리는 것"이라 말이 달라야 한다.
 */
function syntaxMessage(src: string): string {
    const kind = (src.trim().split(/[\s\n]/)[0] ?? '').replace(/[^a-zA-Z-]/g, '');
    if (kind && !KNOWN_KINDS.has(kind.toLowerCase())) {
        return t.mermaid.unsupported(kind);
    }
    return t.mermaid.syntaxError;
}

/** mermaid 11.16.0 이 아는 종류. 여기 없으면 "지원하지 않음"으로 안내한다. */
const KNOWN_KINDS = new Set([
    'graph',
    'flowchart',
    'sequencediagram',
    'classdiagram',
    'statediagram',
    'statediagram-v2',
    'erdiagram',
    'journey',
    'gantt',
    'pie',
    'quadrantchart',
    'requirementdiagram',
    'gitgraph',
    'c4context',
    'mindmap',
    'timeline',
    'zenuml',
    'sankey-beta',
    'xychart-beta',
    'block-beta',
    'packet-beta',
    'kanban',
    'architecture-beta',
    'radar-beta',
    'treemap-beta',
]);

/** 오류 메시지에서 사람이 읽을 만한 첫 줄만. 스택이나 장문을 화면에 쏟지 않는다. */
function firstLine(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const line = raw.split('\n').find((l) => l.trim()) ?? '알 수 없는 오류';
    return line.trim().slice(0, 80);
}

/**
 * 실패한 블록 처리.
 * ★ 코드 블록은 그대로 둔다. 원문이 보이는 것이 이 앱의 마지막 방어선이다(14-3절).
 */
function fail(block: HTMLElement, message: string, src: string): void {
    block.dataset.mermaidState = 'failed';
    const label = block.querySelector('.md-block-label');
    if (label) {
        label.textContent = message;
        label.classList.add('md-block-label--error');
    }
    // 스크린 리더가 "그림"이 아니라 "못 그린 코드"로 읽도록 표시를 남긴다.
    block.setAttribute('aria-label', t.mermaid.sourceBelow(message));
    // 진단용. 화면에는 안 보이지만 개발자가 adb logcat 으로 볼 수 있다.
    console.warn('[mermaid]', message, '\n---\n', src.slice(0, 200));
}

/** 스크린 리더용. 첫 줄(그래프 종류)만 읽어 준다. 없는 것보다 낫다. */
function mermaidAriaLabel(src: string): string {
    const first = src.trim().split('\n')[0]?.slice(0, 40) ?? '';
    return `${t.mermaid.blockLabel}${first ? ` (${first})` : ''}`;
}

/**
 * 테마를 바꾸면 이미 그린 SVG 의 색이 안 맞는다. 다시 그리게 표시만 해 둔다.
 * ★ v1 의 확정 동작: 테마를 바꿔도 이미 그린 다이어그램은 그대로 둔다.
 *   문서를 다시 열면 새 테마로 그려진다. (재렌더 중 화면이 멈추는 쪽이 더 나쁘다.)
 */
export function invalidateMermaid(container: HTMLElement): void {
    mermaidApi = null; // initialize 를 다시 하려면 모듈 상태를 버려야 한다
    for (const b of Array.from(
        container.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-state="done"]'),
    )) {
        b.dataset.mermaidState = 'stale';
    }
}
