import { Browser } from '@capacitor/browser';
import type { RenderHandle } from '../../markdown/render-pipeline';

/**
 * 문서 영역의 링크 클릭을 가로챈다.
 * - '#앵커'  → 문서 안 점프. 아직 렌더되지 않은 청크에 있으면 전부 렌더한 뒤 이동한다.
 * - 그 외    → 시스템 브라우저 (capacitor.config.json 에 allowNavigation 을 두지 않은 이유)
 *
 * ★ 링크를 그냥 두면 앱 안 웹뷰에서 임의의 웹페이지가 열린다.
 *   마크다운은 사용자가 어디서 받아왔는지 알 수 없는 입력이다.
 */
export function bindDocumentLinks(container: HTMLElement, handle: () => RenderHandle | null): void {
    container.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement)?.closest?.('a');
        if (!a) return;

        const href = a.getAttribute('href') ?? '';
        if (!href) return;

        e.preventDefault();

        if (href.startsWith('#')) {
            void jumpToAnchor(href.slice(1), container, handle());
            return;
        }
        if (/^(https?|mailto|tel):/i.test(href)) {
            void Browser.open({ url: href }).catch((err) => {
                // 브라우저(npm run dev)에는 네이티브가 없다. 그때는 새 탭으로 연다.
                console.warn('Browser.open 실패, window.open 으로 폴백:', err);
                window.open(href, '_blank', 'noopener,noreferrer');
            });
        }
        // 그 외 스킴은 sanitize 단계에서 이미 걸러졌다. 여기 오면 무시한다.
    });
}

export async function jumpToAnchor(
    rawId: string,
    container: HTMLElement,
    handle: RenderHandle | null,
): Promise<void> {
    const tryFind = () =>
        container.querySelector(`#${CSS.escape(rawId)}`) ??
        container.querySelector(`#${CSS.escape(decodeURIComponent(rawId))}`) ??
        container.querySelector(`#${CSS.escape(encodeURIComponent(rawId))}`);

    let el = tryFind();
    if (!el && handle) {
        // 아직 안 붙은 청크에 있을 수 있다. 전부 붙이고 다시 찾는다.
        await handle.renderRest();
        el = tryFind();
    }
    if (!el) return;

    /*
     * ★★ 먼 거리는 부드럽게 굴리지 않는다. 두 가지 이유가 겹친다(2026-08-03 실측).
     *   ① 3.6MB 문서에서 목차 맨 끝 항목까지는 60만 px 가 넘는다. 그 거리를 smooth 로
     *      굴리면 도착까지 수 초가 걸린다 — 사용자는 "안 눌렸다"고 느낀다.
     *   ② 더 나쁜 것: 청크가 content-visibility:auto 라 스크롤이 지나가는 동안
     *      실제 높이로 확정되면서 **목표 위치 자체가 계속 아래로 밀린다.**
     *      애니메이션이 끝난 자리는 이미 목표가 아니다.
     *   그래서 먼 거리는 즉시 이동하고, 레이아웃이 확정될 때까지 몇 프레임 보정한다.
     */
    const FAR = window.innerHeight * 3;
    const distance = Math.abs(el.getBoundingClientRect().top);
    const smooth = !prefersReducedMotion() && distance < FAR;

    el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });

    if (!smooth) {
        // 청크가 확정되며 밀려난 만큼 따라잡는다. 자리를 잡으면 일찍 끝낸다.
        for (let i = 0; i < 8; i++) {
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            const top = el.getBoundingClientRect().top;
            if (Math.abs(top) < 4) break;
            el.scrollIntoView({ block: 'start', behavior: 'auto' });
        }
    }

    // 스크린 리더 사용자가 이동을 인지하도록 포커스를 옮긴다(10-3절).
    // scroll-margin-top 이 CSS 에 있어서 상단 바에 가리지 않는다(6-9절).
    (el as HTMLElement).setAttribute('tabindex', '-1');
    (el as HTMLElement).focus({ preventScroll: true });
}

export function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
