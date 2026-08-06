import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 다이어그램 확대 보기 (T6).
 *
 * ★★ 이 화면은 **뒤로가기를 라우터와 나눠 갖는다.** 그게 제일 위험한 지점이다.
 *   자기 몫을 안 알리면 뒤로가기 한 번이 두 겹을 한꺼번에 닫는다 —
 *   다이어그램만 접으려던 사용자가 문서까지 잃는다. 카톡에서 들어왔다면 앱이 꺼진다.
 */

const h = vi.hoisted(() => ({
    backListeners: [] as Array<() => void>,
    exitApp: vi.fn(async () => {}),
}));

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: () => h.exitApp(),
        addListener: async (name: string, fn: () => void) => {
            if (name === 'backButton') h.backListeners.push(fn);
            return {
                remove: async () => {
                    const i = h.backListeners.indexOf(fn);
                    if (i >= 0) h.backListeners.splice(i, 1);
                },
            };
        },
    },
}));

import {
    openDiagramViewer,
    closeDiagramViewer,
    isDiagramViewerOpen,
    bindDiagramZoom,
} from './diagram-viewer';
import { __resetRouterForTest, __pressBackForTest, pushLayer, hasLayer } from '../router';
import { t } from '../../i18n';

function makeSvg(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 400 200');
    svg.style.maxWidth = '100%';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    svg.appendChild(rect);
    return svg;
}

function viewerRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.diagram-viewer');
}

function barButton(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('.diagram-viewer__bar button')].find(
        (b) => b.textContent === text,
    );
}

beforeEach(() => {
    h.backListeners.length = 0;
    h.exitApp.mockClear();
    __resetRouterForTest();
    // pointer capture — jsdom 에 없다. 실제 WebView 에는 있으므로 환경 메우기다.
    if (!Element.prototype.setPointerCapture) {
        Element.prototype.setPointerCapture = function setPointerCapture() {};
    }
});

afterEach(async () => {
    closeDiagramViewer();
    // 리스너가 붙는 경로가 비동기라 뒷정리를 기다린다.
    await Promise.resolve();
    document.body.innerHTML = '';
});

describe('열고 닫기', () => {
    it('원본 SVG 를 복제해 띄운다 — 원본은 건드리지 않는다', () => {
        const src = makeSvg();
        document.body.appendChild(src);

        openDiagramViewer(src, '흐름도');

        const shown = viewerRoot()!.querySelector('svg')!;
        expect(shown).not.toBe(src);
        // 인라인의 폭 제한은 풀려야 원래 크기로 보인다.
        expect(shown.style.maxWidth).toBe('none');
        // ★ 원본은 그대로여야 한다. 여기서 건드리면 문서 안 그림이 망가진다.
        expect(src.style.maxWidth).toBe('100%');
    });

    it('★ 복제본의 id 를 원본과 겹치지 않게 바꾼다', () => {
        const src = makeSvg();
        src.id = 'mmd-1';
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.id = 'mmd-1_pointEnd';
        defs.appendChild(marker);
        src.appendChild(defs);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('marker-end', 'url(#mmd-1_pointEnd)');
        src.appendChild(line);
        document.body.appendChild(src);

        openDiagramViewer(src, '흐름도');

        const clone = viewerRoot()!.querySelector('svg')!;
        /*
         * ★★ 겹쳐 두면 url(#id) 가 **문서에서 처음 만나는 것**으로 풀린다 —
         *   복제본의 화살표가 원본의 정의를 빌려 쓰게 된다. 원본 청크에는
         *   content-visibility: auto 가 걸려 있어서 화면 밖으로 나가면
         *   렌더가 건너뛰어지고 화살촉이 사라질 수 있다.
         */
        expect(clone.id).not.toBe('mmd-1');
        expect(clone.querySelector('marker')!.id).not.toBe('mmd-1_pointEnd');

        // 참조도 함께 바뀌어야 한다 — 안 바꾸면 화살촉이 아예 안 나온다.
        const ref = clone.querySelector('path')!.getAttribute('marker-end')!;
        expect(ref).toBe(`url(#${clone.querySelector('marker')!.id})`);

        // 원본은 그대로다.
        expect(src.id).toBe('mmd-1');
        expect(src.querySelector('marker')!.id).toBe('mmd-1_pointEnd');
    });

    it('두 번 열어도 서로 다른 id 를 쓴다', () => {
        const src = makeSvg();
        src.id = 'mmd-1';
        openDiagramViewer(src, '첫 번째');
        const a = viewerRoot()!.querySelector('svg')!.id;
        openDiagramViewer(src, '두 번째');
        const b = viewerRoot()!.querySelector('svg')!.id;
        expect(a).not.toBe(b);
    });

    it('id 가 없는 그림도 그냥 열린다', () => {
        expect(() => openDiagramViewer(makeSvg(), '그림')).not.toThrow();
        expect(isDiagramViewerOpen()).toBe(true);
    });

    it('소리로 읽을 이름을 그대로 쓴다', () => {
        openDiagramViewer(makeSvg(), '주문 흐름도');
        const root = viewerRoot()!;
        expect(root.getAttribute('role')).toBe('dialog');
        expect(root.getAttribute('aria-modal')).toBe('true');
        expect(root.getAttribute('aria-label')).toBe('주문 흐름도');
    });

    it('닫기 버튼으로 닫힌다', () => {
        openDiagramViewer(makeSvg(), '그림');
        expect(isDiagramViewerOpen()).toBe(true);

        barButton(t.common.close)!.click();

        expect(isDiagramViewerOpen()).toBe(false);
        expect(viewerRoot()).toBeNull();
    });

    it('뒤 문서가 같이 스크롤되지 않게 하고, 닫으면 되돌린다', () => {
        openDiagramViewer(makeSvg(), '그림');
        expect(document.documentElement.style.overflow).toBe('hidden');

        closeDiagramViewer();
        expect(document.documentElement.style.overflow).toBe('');
    });

    it('두 번 열면 앞의 것이 남지 않는다', () => {
        openDiagramViewer(makeSvg(), '첫 번째');
        openDiagramViewer(makeSvg(), '두 번째');

        expect(document.querySelectorAll('.diagram-viewer')).toHaveLength(1);
        expect(viewerRoot()!.getAttribute('aria-label')).toBe('두 번째');
    });

    it('닫혀 있을 때 닫아도 터지지 않는다', () => {
        expect(() => closeDiagramViewer()).not.toThrow();
    });
});

describe('★ 뒤로가기는 한 겹만 닫는다', () => {
    it('다이어그램이 열려 있으면 뒤로가기가 문서까지 닫지 않는다', async () => {
        const closeDocument = vi.fn(() => true);
        pushLayer('viewer', closeDocument);

        openDiagramViewer(makeSvg(), '그림');
        await Promise.resolve(); // 리스너 등록이 비동기다

        const handled = await __pressBackForTest();

        /*
         * ★★ 다이어그램이 자기 몫을 라우터에 알리지 않으면 뒤로가기가 그냥
         *   아래 레이어로 새어 나간다. 사용자는 그림을 접으려 했는데
         *   **문서까지 닫힌다** — 밖에서 들어온 문서였다면 앱이 통째로 꺼진다.
         */
        expect(handled, '뒤로가기를 다이어그램이 받지 않았다').toBe('diagram');
        expect(closeDocument, '문서 레이어까지 불렸다').not.toHaveBeenCalled();
        expect(isDiagramViewerOpen()).toBe(false);
    });

    it('닫은 뒤에는 뒤로가기가 아래로 내려간다', async () => {
        const closeDocument = vi.fn(() => true);
        pushLayer('viewer', closeDocument);

        openDiagramViewer(makeSvg(), '그림');
        await Promise.resolve();
        closeDiagramViewer();

        // 떼지 않으면 화면에 없는 그림이 뒤로가기 한 번을 계속 먹는다(9-4절).
        expect(hasLayer('diagram')).toBe(false);
        expect(await __pressBackForTest()).toBe('viewer');
        expect(closeDocument).toHaveBeenCalledOnce();
    });

    it('★ 네이티브 뒤로가기 리스너를 따로 달지 않는다', async () => {
        openDiagramViewer(makeSvg(), '그림');
        await Promise.resolve();

        /*
         * ★★ Capacitor 는 등록된 backButton 리스너를 **전부** 부른다.
         *   라우터가 이미 하나 갖고 있으므로 여기서 또 달면 한 번 누를 때 둘 다 돈다.
         */
        expect(h.backListeners, '뒤로가기 리스너가 중복 등록됐다').toHaveLength(0);
    });

    it('Esc 로도 닫힌다 — 브라우저에서 확인할 때 쓴다', () => {
        openDiagramViewer(makeSvg(), '그림');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(isDiagramViewerOpen()).toBe(false);
    });

    it('닫은 뒤 Esc 는 아무것도 하지 않는다', () => {
        const closeDocument = vi.fn(() => true);
        pushLayer('viewer', closeDocument);
        openDiagramViewer(makeSvg(), '그림');
        closeDiagramViewer();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(closeDocument).not.toHaveBeenCalled();
    });
});

describe('배율', () => {
    it('처음에는 맞춤 배율이고 퍼센트를 보여 준다', () => {
        openDiagramViewer(makeSvg(), '그림');
        expect(document.querySelector('.diagram-viewer__pct')?.textContent).toMatch(/^\d+%$/);
    });

    it('확대·축소가 퍼센트에 반영된다', () => {
        openDiagramViewer(makeSvg(), '그림');
        const pct = () => document.querySelector('.diagram-viewer__pct')!.textContent!;
        const before = parseInt(pct(), 10);

        barButton('+')!.click();
        expect(parseInt(pct(), 10)).toBeGreaterThan(before);

        barButton('−')!.click();
        expect(parseInt(pct(), 10)).toBe(before);
    });

    it('★ 상하한을 넘지 않는다', () => {
        openDiagramViewer(makeSvg(), '그림');
        const pct = () =>
            parseInt(document.querySelector('.diagram-viewer__pct')!.textContent!, 10);

        for (let i = 0; i < 30; i++) barButton('+')!.click();
        expect(pct()).toBe(600); // MAX_SCALE 6

        for (let i = 0; i < 40; i++) barButton('−')!.click();
        expect(pct()).toBe(25); // MIN_SCALE 0.25
    });

    it('맞춤 버튼이 처음 배율로 되돌린다', () => {
        openDiagramViewer(makeSvg(), '그림');
        const pct = () => document.querySelector('.diagram-viewer__pct')!.textContent!;
        const fit = pct();

        barButton('+')!.click();
        barButton('+')!.click();
        expect(pct()).not.toBe(fit);

        barButton(t.diagram.fit)!.click();
        expect(pct()).toBe(fit);
    });
});

describe('문서에서 탭하면 열린다', () => {
    it('.mermaid-svg 를 누르면 확대 보기가 뜬다', () => {
        const container = document.createElement('div');
        const holder = document.createElement('div');
        holder.className = 'mermaid-svg';
        holder.setAttribute('aria-label', '순서도');
        holder.appendChild(makeSvg());
        container.appendChild(holder);
        document.body.appendChild(container);

        bindDiagramZoom(container);
        holder.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(isDiagramViewerOpen()).toBe(true);
        expect(viewerRoot()!.getAttribute('aria-label')).toBe('순서도');
    });

    it('다이어그램이 아닌 곳을 눌러도 열리지 않는다', () => {
        const container = document.createElement('div');
        const p = document.createElement('p');
        p.textContent = '그냥 문단';
        container.appendChild(p);
        document.body.appendChild(container);

        bindDiagramZoom(container);
        p.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(isDiagramViewerOpen()).toBe(false);
    });

    it('위임이라 나중에 붙는 다이어그램에도 걸린다', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        bindDiagramZoom(container); // 아직 아무것도 없다

        // upgradeMermaidBlocks 가 나중에 붙이는 상황
        const holder = document.createElement('div');
        holder.className = 'mermaid-svg';
        holder.appendChild(makeSvg());
        container.appendChild(holder);

        holder.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(isDiagramViewerOpen()).toBe(true);
    });
});

/**
 * ★★ 2026-08-06. **확대·축소 단추가 기호로만 읽혔다.**
 *
 *   화면에는 '−' '+' 만 보이는데 접근성 이름을 따로 주지 않아서,
 *   스크린 리더가 잡는 이름이 그대로 'U+2212' 와 '+' 였다(실측).
 *   무슨 단추인지 알 방법이 없다.
 *
 *   ★ 이 앱의 다른 아이콘 단추는 전부 iconButton() 이 aria-label 을 붙여 준다.
 *     이 화면만 자기 button() 헬퍼를 따로 써서 그 그물 밖에 있었다 —
 *     카탈로그 키 196개 중 **안 쓰이는 키를 찾다가** 걸렸다(t.diagram.close 가
 *     떠 있었고, 그 자리를 보러 갔다가 옆의 두 단추가 드러났다).
 */
describe('★★ 확대 보기의 접근성 이름', () => {
    function open(): HTMLElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        openDiagramViewer(svg, '흐름도');
        return document.querySelector<HTMLElement>('.diagram-viewer')!;
    }

    it('★ 확대·축소 단추에 이름이 있다', () => {
        const root = open();
        const 이름 = [...root.querySelectorAll('button')].map(
            (b) => b.getAttribute('aria-label') || b.textContent?.trim(),
        );
        expect(이름).toContain(t.diagram.zoomIn);
        expect(이름).toContain(t.diagram.zoomOut);
        expect(이름, '기호가 그대로 이름이 되면 안 된다').not.toContain('−');
        closeDiagramViewer();
    });

    it('글자가 이미 말인 단추는 그대로 둔다 (이름을 두 번 붙이지 않는다)', () => {
        const root = open();
        const 맞춤 = [...root.querySelectorAll('button')].find(
            (b) => b.textContent?.trim() === t.diagram.fit,
        )!;
        expect(맞춤.getAttribute('aria-label')).toBeNull();
        closeDiagramViewer();
    });

    it('★ 배율이 바뀐 것을 소리로도 알린다', () => {
        const root = open();
        const pct = root.querySelector('.diagram-viewer__pct')!;
        expect(pct.getAttribute('aria-live')).toBe('polite');
        expect(pct.getAttribute('role')).toBe('status');

        const 전 = pct.textContent;
        [...root.querySelectorAll('button')]
            .find((b) => b.getAttribute('aria-label') === t.diagram.zoomIn)!
            .click();
        expect(pct.textContent, '눌러도 값이 그대로면 알릴 것이 없다').not.toBe(전);
        closeDiagramViewer();
    });
});
