/**
 * 다이어그램 확대 보기 (T6).
 *
 * 왜 있는가 — 2026-08-03 실기기에서 확인한 문제:
 *   Mermaid 시퀀스 다이어그램은 폰 화면보다 넓다. 인라인에서 가로 스크롤만 두면
 *   **밀 수 있다는 것을 알 방법이 없고**, 밀어도 전체 구조가 한눈에 안 들어온다.
 *   다이어그램에서 중요한 정보는 대개 '전체 모양'이라 잘린 채로는 값이 크게 떨어진다.
 *
 * 그래서 두 단계로 나눈다.
 *   인라인 → 폭에 맞춰 축소. 전체 구조가 한눈에 보인다 (markdown.css 의 max-width:100%)
 *   탭      → 이 오버레이. 원래 크기로 보고 끌어서 이동, 버튼으로 확대·축소
 *
 * ★★ 뒤로가기는 **라우터에만 맡긴다**(9-3절). 여기서 App.addListener('backButton') 을
 *   따로 달면 안 된다 — Capacitor 는 등록된 리스너를 전부 부르므로 라우터의 것과 함께
 *   돌아서 **한 번 누를 때 두 겹이 닫힌다.** 그림만 접으려던 사용자가 문서까지 잃고,
 *   밖에서 들어온 문서였다면 앱이 통째로 꺼진다.
 *   (라우터가 생기기 전에 직접 받던 코드가 남아 있었다 — 2026-08-05 테스트로 확인)
 */

import { pushLayer, removeLayer } from '../router';
import { t } from '../../i18n';

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const STEP = 1.4;

let openEl: HTMLElement | null = null;
let detachKeys: (() => void) | null = null;

export function isDiagramViewerOpen(): boolean {
    return openEl !== null;
}

export function closeDiagramViewer(): void {
    if (!openEl) return;
    openEl.remove();
    openEl = null;
    // ★ 애니메이션을 기다리지 않고 지금 뗀다 — 기다리면 화면에 없는 그림이
    //   뒤로가기 한 번을 먹는다(9-4절).
    removeLayer('diagram');
    detachKeys?.();
    detachKeys = null;
    document.documentElement.style.overflow = '';
}

/** 원본 SVG 를 복제해 전체 화면으로 띄운다. 원본은 건드리지 않는다. */
export function openDiagramViewer(sourceSvg: SVGElement, label: string): void {
    closeDiagramViewer();

    const root = document.createElement('div');
    root.className = 'diagram-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', label);

    // ── 상단 바
    const bar = document.createElement('div');
    bar.className = 'diagram-viewer__bar';

    const close = button(t.common.close, 'diagram-viewer__close', closeDiagramViewer);
    const zoomOut = button('−', '', () => setScale(scale / STEP));
    const pct = document.createElement('span');
    pct.className = 'diagram-viewer__pct';
    const zoomIn = button('+', '', () => setScale(scale * STEP));
    const fitBtn = button(t.diagram.fit, '', () => setScale(fitScale));

    bar.append(close, zoomOut, pct, zoomIn, fitBtn);

    // ── 그림판 (끌어서 이동)
    const pane = document.createElement('div');
    pane.className = 'diagram-viewer__pane';

    const stage = document.createElement('div');
    stage.className = 'diagram-viewer__stage';

    const svg = sourceSvg.cloneNode(true) as SVGElement;
    // 인라인에서 걸어 둔 폭 제한을 풀어 원래 크기로 되돌린다.
    svg.removeAttribute('style');
    svg.style.maxWidth = 'none';
    svg.style.width = 'auto';
    svg.style.height = 'auto';
    stage.appendChild(svg);
    pane.appendChild(stage);

    root.append(bar, pane);
    document.body.appendChild(root);
    openEl = root;
    // 뒤 문서가 같이 스크롤되지 않게 한다.
    document.documentElement.style.overflow = 'hidden';

    // ── 배율
    const natural = svg.getBoundingClientRect();
    const fitScale = clamp(
        Math.min(
            (pane.clientWidth - 24) / (natural.width || 1),
            (pane.clientHeight - 24) / (natural.height || 1),
        ),
        MIN_SCALE,
        1,
    );
    let scale = fitScale;

    function setScale(next: number): void {
        scale = clamp(next, MIN_SCALE, MAX_SCALE);
        stage.style.transform = `scale(${scale})`;
        pct.textContent = `${Math.round(scale * 100)}%`;
    }
    setScale(fitScale);

    // ── 끌어서 이동 (포인터 하나면 pan, 둘이면 브라우저 기본 핀치에 맡긴다)
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    pane.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary) return;
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        sl = pane.scrollLeft;
        st = pane.scrollTop;
        pane.setPointerCapture(e.pointerId);
    });
    pane.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        pane.scrollLeft = sl - (e.clientX - sx);
        pane.scrollTop = st - (e.clientY - sy);
    });
    const endDrag = () => {
        dragging = false;
    };
    pane.addEventListener('pointerup', endDrag);
    pane.addEventListener('pointercancel', endDrag);

    // 더블탭 = 맞춤 ↔ 100% 전환
    pane.addEventListener('dblclick', () => {
        setScale(Math.abs(scale - fitScale) < 0.01 ? 1 : fitScale);
    });

    // ── 닫는 경로: 닫기 버튼 / 안드로이드 뒤로가기 / Esc
    // ★ 여는 함수 안에서 동기적으로 등록한다(9-3절).
    pushLayer('diagram', () => {
        closeDiagramViewer();
        return true; // 내가 처리했다 — 아래 문서 레이어로 내려보내지 않는다
    });

    // Esc 는 브라우저(npm run dev)에서 확인할 때 쓴다. 기기에는 키보드가 없다.
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeDiagramViewer();
    };
    document.addEventListener('keydown', onKey);
    detachKeys = () => document.removeEventListener('keydown', onKey);

    close.focus();
}

/**
 * 문서 컨테이너의 다이어그램을 탭하면 확대 보기가 열리도록 묶는다.
 * 렌더가 끝난 뒤(또는 upgradeMermaidBlocks 뒤에) 한 번만 부르면 된다 — 위임이라 나중에
 * 추가되는 블록에도 걸린다.
 */
export function bindDiagramZoom(container: HTMLElement): void {
    container.addEventListener('click', (e) => {
        const holder = (e.target as HTMLElement)?.closest?.('.mermaid-svg');
        if (!holder) return;
        const svg = holder.querySelector('svg');
        if (!svg) return;
        e.preventDefault();
        openDiagramViewer(svg, holder.getAttribute('aria-label') ?? t.diagram.label);
    });
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
