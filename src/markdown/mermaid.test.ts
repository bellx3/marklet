import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Mermaid 지연 렌더 (6-12절) — **로드 실패를 어떻게 다루는가**만 본다.
 *
 * ★★ 이 파일이 존재하는 이유. 예전에는 `loadFailed = true` 로 한 번 실패하면 영영 잠갔다.
 *   저메모리 기기에서 900KB 청크가 한 번 미끄러지면 **앱을 다시 켤 때까지
 *   모든 문서의 다이어그램이 죽는다.** 사용자는 코드 블록만 보고 고장으로 읽는다.
 *   원인은 대개 일시적이므로 다음 문서에서 다시 해 볼 값어치가 있다 —
 *   다만 무제한은 아니다(정말 안 되는 기기에서 매번 900KB 를 다시 받으면 더 나쁘다).
 */

let loadAttempts = 0;
let shouldFail = true;

const render = vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><g/></svg>` }));
/** ★ 코드가 그리기 전에 문법을 먼저 검사한다(suppressErrors). 목에도 있어야 한다. */
const parse = vi.fn(async () => true);
/** ★ 모듈 밖에 둔다 — 매번 새로 만들면 "몇 번 불렸나"를 셀 수 없다. */
const initialize = vi.fn();

vi.mock('mermaid', () => ({
    get default() {
        loadAttempts += 1;
        if (shouldFail) throw new Error('청크를 받지 못했습니다');
        return { initialize, parse, render };
    },
}));

// 살균은 이 테스트의 관심사가 아니다. 그대로 통과시킨다.
vi.mock('./sanitize', () => ({ sanitizeMermaidSvg: (s: string) => s }));

const { upgradeMermaidBlocks, __resetMermaidLoadForTest } = await import('./mermaid');
const { t } = await import('../i18n');

/** `markMermaidBlocks` 가 만드는 모양을 그대로 흉내 낸다. */
function container(count = 1): HTMLElement {
    const host = document.createElement('div');
    for (let i = 0; i < count; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-block';
        wrap.dataset.mermaidSrc = 'flowchart LR\n A --> B';
        wrap.dataset.mermaidState = 'pending';
        const label = document.createElement('div');
        label.className = 'md-block-label';
        label.textContent = t.mermaid.blockLabel;
        const pre = document.createElement('pre');
        wrap.append(label, pre);
        host.appendChild(wrap);
    }
    return host;
}

beforeEach(() => {
    loadAttempts = 0;
    shouldFail = true;
    render.mockClear();
    parse.mockClear();
    initialize.mockClear();
    document.documentElement.removeAttribute('data-theme');
    __resetMermaidLoadForTest();
});

describe('로드 실패', () => {
    it('던지지 않고 블록에 안내를 남긴다', async () => {
        const host = container();
        await expect(upgradeMermaidBlocks(host)).resolves.toBeUndefined();

        const block = host.querySelector<HTMLElement>('.mermaid-block')!;
        expect(block.dataset.mermaidState).toBe('failed');
        expect(block.querySelector('.md-block-label')?.textContent).toBe(t.mermaid.loadFailed);
    });

    /*
     * ★ 핵심. 한 번 실패했다고 영영 잠그면 안 된다.
     *   같은 앱 실행 안에서 다음 문서를 열었을 때 다시 시도해야 한다.
     */
    it('★ 다음 문서에서 다시 시도한다 (영구 차단이 아니다)', async () => {
        await upgradeMermaidBlocks(container());
        expect(loadAttempts).toBe(1);

        shouldFail = false; // 메모리가 풀렸다고 치자
        const host = container();
        await upgradeMermaidBlocks(host);

        expect(loadAttempts).toBe(2);
        expect(host.querySelector<HTMLElement>('.mermaid-block')?.dataset.mermaidState).toBe(
            'done',
        );
    });

    it('★ 그렇다고 무제한으로 다시 받지는 않는다', async () => {
        for (let i = 0; i < 6; i++) await upgradeMermaidBlocks(container());
        expect(loadAttempts).toBe(3);
    });

    it('성공하면 다시 받지 않는다', async () => {
        shouldFail = false;
        await upgradeMermaidBlocks(container());
        await upgradeMermaidBlocks(container());
        expect(loadAttempts).toBe(1);
    });
});

describe('정상 렌더', () => {
    beforeEach(() => {
        shouldFail = false;
    });

    it('pending 블록을 SVG 로 바꾼다', async () => {
        const host = container(2);
        await upgradeMermaidBlocks(host);

        const states = [...host.querySelectorAll<HTMLElement>('.mermaid-block')].map(
            (b) => b.dataset.mermaidState,
        );
        expect(states).toEqual(['done', 'done']);
        expect(render).toHaveBeenCalledTimes(2);
    });

    it('pending 이 없으면 로드조차 하지 않는다', async () => {
        const host = document.createElement('div');
        await upgradeMermaidBlocks(host);
        expect(loadAttempts).toBe(0);
    });
});

describe('★ 테마', () => {
    beforeEach(() => {
        shouldFail = false;
    });

    const themeOf = (call: number) =>
        (initialize.mock.calls[call]?.[0] as { theme?: string } | undefined)?.theme;

    it('라이트에서는 default, 다크에서는 dark 로 시작한다', async () => {
        await upgradeMermaidBlocks(container());
        expect(themeOf(0)).toBe('default');

        __resetMermaidLoadForTest();
        initialize.mockClear();
        document.documentElement.dataset.theme = 'dark';
        await upgradeMermaidBlocks(container());
        expect(themeOf(0)).toBe('dark');
    });

    it('★★ 테마가 바뀌면 initialize 를 다시 부른다', async () => {
        await upgradeMermaidBlocks(container());
        expect(initialize).toHaveBeenCalledTimes(1);

        document.documentElement.dataset.theme = 'dark';
        await upgradeMermaidBlocks(container());

        /*
         * ★★ 이걸 안 하면 **테마가 영영 고정된다.** mermaidApi 를 캐시해 두고
         *   그대로 돌려주므로 initialize 가 다시 안 불린다 — 라이트에서 켠 앱은
         *   다크로 바꾸고 문서를 다시 열어도 흰 배경 다이어그램을 그리고,
         *   다크 화면에서는 글씨가 거의 안 보인다(실측 대비 1.41:1).
         */
        expect(initialize).toHaveBeenCalledTimes(2);
        expect(themeOf(1)).toBe('dark');
    });

    it('테마가 그대로면 다시 부르지 않는다', async () => {
        await upgradeMermaidBlocks(container());
        await upgradeMermaidBlocks(container());
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    it('테마를 다시 바꿔도 청크는 한 번만 받는다', async () => {
        await upgradeMermaidBlocks(container());
        document.documentElement.dataset.theme = 'dark';
        await upgradeMermaidBlocks(container());
        document.documentElement.removeAttribute('data-theme');
        await upgradeMermaidBlocks(container());

        // 900KB 를 테마 바꿀 때마다 다시 받으면 그게 더 나쁘다.
        expect(loadAttempts).toBe(1);
        expect(initialize).toHaveBeenCalledTimes(3);
    });
});

describe('★ 소리로 읽히는 이름', () => {
    beforeEach(() => {
        shouldFail = false;
    });

    it('다이어그램 종류와 확대 안내를 함께 읽어 준다', async () => {
        const host = container();
        await upgradeMermaidBlocks(host);

        const label = host.querySelector('.mermaid-svg')?.getAttribute('aria-label') ?? '';
        expect(label).toContain(t.mermaid.blockLabel);
        expect(label).toContain('flowchart LR');
        /*
         * ★★ 화면에서는 CSS ::after 가 "탭하면 크게 보기" 를 보여 주는데
         *   **의사요소는 접근성 트리에 안 올라간다.** 여기 없으면 소리로 듣는 사람은
         *   확대할 수 있다는 걸 알 방법이 없다 — 다이어그램은 폰 화면보다 넓다.
         */
        expect(label).toContain(t.diagram.zoomHint);
    });

    it('그림으로 인지되고 포커스가 간다', async () => {
        const host = container();
        await upgradeMermaidBlocks(host);

        const holder = host.querySelector<HTMLElement>('.mermaid-svg')!;
        expect(holder.getAttribute('role')).toBe('img');
        expect(holder.tabIndex).toBe(0);
    });
});
