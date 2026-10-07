import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S1 뷰어 화면 — 문서를 갈아탈 때 앞 문서의 것이 남지 않는지.
 *
 * ★★ 왜 여기가 위험한가.
 *   뷰어는 컨테이너를 재사용한다. 화면·시트·오버레이를 문서마다 새로 만들지 않고
 *   같은 것을 다시 채운다(그게 빠르니까). 그래서 **지우는 것을 빠뜨리면
 *   앞 문서의 잔해가 새 문서 위에 그대로 남는다** — 그런데 화면은 멀쩡해 보인다.
 *
 * ★ 문서를 갈아타는 길은 사실상 하나뿐이다: **밖에서 들어오는 인텐트**.
 *   앱 안에서는 시트를 닫아야만 다른 문서로 갈 수 있어서 손으로는 재현이 어렵다.
 *   카톡에서 .md 를 누르면 시트가 열려 있든 말든 새 문서가 밀고 들어온다.
 */

const h = vi.hoisted(() => ({
    nativeStore: new Map<string, string>(),
    /** 수식 청크 받기를 일부러 늦춘다. 0 이면 예전과 똑같이 돈다. */
    mathDelayMs: 0,
}));

/*
 * ★ KaTeX 는 396KB 라 모바일 데이터에서 몇 초씩 걸린다. 그 사이에 다른 문서가
 *   들어오는 상황을 재현하려면 **기다리는 시간**이 있어야 한다.
 *   목이 즉시 끝나면 경합 자체가 생기지 않아 테스트가 아무것도 못 본다.
 */
vi.mock('../../markdown/math', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../markdown/math')>();
    return {
        ...real,
        ensureMath: async (md: Parameters<typeof real.ensureMath>[0]) => {
            if (h.mathDelayMs) await new Promise((r) => setTimeout(r, h.mathDelayMs));
            return real.ensureMath(md);
        },
    };
});

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: vi.fn(async () => {}),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
}));

vi.mock('@capacitor/browser', () => ({
    Browser: { open: vi.fn(async () => {}) },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: h.nativeStore.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            h.nativeStore.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            h.nativeStore.delete(key);
        },
    },
}));

import { createViewerScreen, type ViewerScreen } from './viewer-screen';
import { __resetRouterForTest, hasLayer, pushLayer, __pressBackForTest } from '../router';
import { t } from '../../i18n';
import type { MdDocument } from '../../plugins/md-file';

function doc(over: Partial<MdDocument> = {}): MdDocument {
    return {
        uri: 'content://docs/a.md',
        name: 'a.md',
        size: 128,
        mimeType: 'text/markdown',
        writable: true,
        ...over,
    };
}

const cb = {
    onBack: vi.fn(),
    onEdit: vi.fn(),
    onSettings: vi.fn(),
    onPickFile: vi.fn(),
    onShare: vi.fn(),
    onSharePlain: vi.fn(),
    onShareFile: vi.fn(),
};

let screen: ViewerScreen;

function buttonByLabel(label: string): HTMLButtonElement | null {
    return (
        [...document.querySelectorAll('button')].find(
            (b) => b.getAttribute('aria-label') === label,
        ) ?? null
    );
}

/** 붙어 있는 타이머·마이크로태스크가 풀릴 때까지 돌린다. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(50);
}

beforeEach(() => {
    vi.useFakeTimers();
    h.nativeStore.clear();
    __resetRouterForTest();
    Object.values(cb).forEach((f) => f.mockClear());

    // 모션 줄이기를 켠 상태로 본다 — 오버레이가 타이머 없이 즉시 확정되어
    // '열렸다/닫혔다'를 애매함 없이 볼 수 있다.
    vi.spyOn(window, 'matchMedia').mockImplementation(
        (q: string) =>
            ({
                matches: q.includes('prefers-reduced-motion'),
                media: q,
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }) as unknown as MediaQueryList,
    );

    screen = createViewerScreen(cb);
    document.body.appendChild(screen.root);
});

afterEach(() => {
    screen.destroy();
    vi.useRealTimers();
});

describe('뷰어 — 기본', () => {
    it('문서 이름을 제목에 건다', async () => {
        await screen.show(doc({ name: '회의록.md' }), '# 안녕\n\n본문');
        expect(screen.root.querySelector('.topbar-title')?.textContent).toBe('회의록.md');
    });

    it('본문을 그린다', async () => {
        await screen.show(doc(), '# 제목\n\n문단 하나');
        await settle();
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('문단 하나');
    });

    it('읽기 전용 문서에 안내 줄을 띄운다', async () => {
        await screen.show(doc({ writable: false }), '# 문서');
        const notice = screen.root.querySelector<HTMLElement>('.viewer-notice');
        expect(notice?.hidden).toBe(false);
        expect(notice?.textContent).toBe(t.viewer.readOnlyNotice);
    });

    it('사본을 보고 있으면 그렇게 말한다', async () => {
        await screen.show(doc(), '# 문서', { fromSnapshot: true });
        expect(screen.root.querySelector<HTMLElement>('.viewer-notice')?.textContent).toBe(
            t.viewer.snapshotNotice,
        );
    });

    it('원문만 보여 주는 문서에는 편집 버튼을 감춘다', async () => {
        await screen.show(doc(), '아주 큰 문서', { plain: true });
        expect(buttonByLabel(t.viewer.edit)?.hidden).toBe(true);
    });

    it('파일이 아닌 문서에는 파일 공유를 감춘다', async () => {
        await screen.show(doc({ uri: '' }), '# 예제');
        const item = [...screen.root.querySelectorAll<HTMLElement>('.menu-item')].find(
            (b) => b.textContent === t.viewer.shareFile,
        );
        expect(item?.hidden).toBe(true);
    });
});

describe('⋮ 메뉴', () => {
    it('열고 닫을 때 aria-expanded 가 따라간다', async () => {
        await screen.show(doc(), '# 문서');
        const moreBtn = buttonByLabel(t.viewer.more)!;
        const menu = screen.root.querySelector<HTMLElement>('.more-menu')!;

        expect(menu.hidden).toBe(true);
        moreBtn.click();
        expect(menu.hidden).toBe(false);
        expect(moreBtn.getAttribute('aria-expanded')).toBe('true');

        moreBtn.click();
        expect(menu.hidden).toBe(true);
        expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('상단 바 안에 있다 — 형제로 두면 본문을 아래로 밀어낸다', async () => {
        await screen.show(doc(), '# 문서');
        const menu = screen.root.querySelector<HTMLElement>('.more-menu')!;
        // 2026-08-04 사용자가 지적한 그 버그. 구조로 고정해 둔다.
        expect(menu.closest('.app-topbar')).not.toBeNull();
    });

    it('바깥(스크림)을 누르면 닫힌다', async () => {
        await screen.show(doc(), '# 문서');
        buttonByLabel(t.viewer.more)!.click();

        const scrim = screen.root.querySelector<HTMLElement>('.menu-scrim')!;
        expect(scrim.hidden).toBe(false);
        scrim.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(screen.root.querySelector<HTMLElement>('.more-menu')!.hidden).toBe(true);
    });

    /*
     * ★★★ 2026-08-07 실기기. 이 앱의 겹침은 전부 레이어를 얹는데 **⋮ 메뉴만 빠져 있었다.**
     *   메뉴를 열어 두고 뒤로가기를 누르면 메뉴가 아니라 **문서가 닫히고 홈으로 떨어졌다** —
     *   읽던 자리를 통째로 잃는다. 메뉴를 열었다 무르는 건 흔한 동작이다.
     *
     * ★ 아래 화면(문서)을 흉내 낸 레이어를 깔고 본다. 그래야 "메뉴만 닫혔는가"와
     *   "아래 것까지 닫혔는가"가 갈린다 — 메뉴 하나만 두고 재면 둘 다 통과한다.
     */
    it('★★ 열려 있으면 뒤로가기를 받는다 — 문서가 대신 닫히면 안 된다', async () => {
        await screen.show(doc(), '# 문서');
        const 아래 = vi.fn(() => true);
        pushLayer('viewer', 아래);

        buttonByLabel(t.viewer.more)!.click();
        expect(hasLayer('menu'), '열면 레이어를 얹는다').toBe(true);

        expect(await __pressBackForTest()).toBe('menu');
        expect(screen.root.querySelector<HTMLElement>('.more-menu')!.hidden).toBe(true);
        expect(아래, '아래 화면까지 닫히면 안 된다').not.toHaveBeenCalled();
        expect(hasLayer('menu')).toBe(false);

        // 닫힌 뒤의 뒤로가기는 아래 화면 몫이다 — 메뉴가 한 번을 더 먹으면 안 된다.
        expect(await __pressBackForTest()).toBe('viewer');
        expect(아래).toHaveBeenCalledTimes(1);
    });

    it('메뉴를 닫는 다른 길들도 레이어를 뗀다 — 남으면 뒤로가기 한 번이 먹힌다', async () => {
        await screen.show(doc(), '# 문서');

        /** ⋮ 를 누르고, 레이어가 실제로 얹혔는지까지 본다 — 안 그러면 아래 검사가 공치다. */
        const 메뉴열기 = () => {
            buttonByLabel(t.viewer.more)!.click();
            expect(hasLayer('menu'), '열면 레이어를 얹는다').toBe(true);
        };

        // ⋮ 를 한 번 더 눌러 닫기
        메뉴열기();
        buttonByLabel(t.viewer.more)!.click();
        expect(hasLayer('menu'), '토글로 닫았을 때').toBe(false);

        // 스크림 누르기
        메뉴열기();
        screen.root
            .querySelector<HTMLElement>('.menu-scrim')!
            .dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(hasLayer('menu'), '바깥을 눌러 닫았을 때').toBe(false);

        // 항목 누르기
        메뉴열기();
        [...screen.root.querySelectorAll<HTMLElement>('.menu-item')]
            .find((b) => b.textContent === t.common.settings)!
            .click();
        expect(hasLayer('menu'), '항목을 눌러 닫았을 때').toBe(false);

        // 화면을 갈아탈 때 (closeOverlays)
        메뉴열기();
        screen.closeOverlays();
        expect(hasLayer('menu'), '문서를 갈아탈 때').toBe(false);
    });
});

describe('★ 문서를 갈아탈 때', () => {
    /** 목차 시트를 연다. 시트는 #overlay-root(없으면 body)에 붙는다. */
    function openToc(): HTMLElement {
        buttonByLabel(t.viewer.toc)!.click();
        const sheet = document.querySelector<HTMLElement>('[aria-labelledby="toc-title"]')!;
        expect(sheet, '목차 시트가 없다').not.toBeNull();
        return sheet;
    }

    it('앞 문서의 목차 시트가 새 문서 위에 남지 않는다', async () => {
        await screen.show(doc(), '# 첫째\n\n가\n\n## 둘째\n\n나');
        await settle();

        const sheet = openToc();
        expect(sheet.hidden).toBe(false);
        expect(sheet.textContent).toContain('첫째');

        // 카톡에서 다른 .md 를 눌렀다. 시트를 닫을 틈이 없다.
        await screen.show(doc({ uri: 'content://docs/b.md', name: 'b.md' }), '# 전혀 다른 문서');
        await settle();

        /*
         * ★★ 남으면 **앞 문서의 제목들이 새 문서의 목차인 척** 떠 있게 된다.
         *   눌러도 그 id 가 새 문서에 없으니 아무 일도 안 일어난다.
         */
        expect(sheet.hidden).toBe(true);
    });

    it("앞 문서의 목차가 back 스택에 'toc' 를 남기지 않는다", async () => {
        await screen.show(doc(), '# 첫째');
        await settle();
        openToc();
        expect(hasLayer('toc')).toBe(true);

        await screen.show(doc({ uri: 'content://docs/b.md' }), '# 다른 문서');
        await settle();

        // 남으면 뒤로가기 한 번을 이미 화면에 없는 시트가 잡아먹는다(9-4절).
        expect(hasLayer('toc')).toBe(false);
    });

    it('⋮ 메뉴가 새 문서 위에 남지 않는다', async () => {
        await screen.show(doc(), '# 문서');
        buttonByLabel(t.viewer.more)!.click();
        expect(screen.root.querySelector<HTMLElement>('.more-menu')!.hidden).toBe(false);

        await screen.show(doc({ uri: 'content://docs/b.md' }), '# 다른 문서');
        await settle();

        const menu = screen.root.querySelector<HTMLElement>('.more-menu')!;
        expect(menu.hidden).toBe(true);
        // 스크림이 남으면 화면 전체가 눌리지 않는다.
        expect(screen.root.querySelector<HTMLElement>('.menu-scrim')!.hidden).toBe(true);
    });

    it('보기 설정 시트가 새 문서 위에 남지 않는다', async () => {
        await screen.show(doc(), '# 문서');
        buttonByLabel(t.viewer.more)!.click();
        [...screen.root.querySelectorAll<HTMLElement>('.menu-item')]
            .find((b) => b.textContent === t.viewer.viewSettings)!
            .click();

        const sheet = document.querySelector<HTMLElement>('[aria-labelledby="view-title"]')!;
        expect(sheet.hidden).toBe(false);

        await screen.show(doc({ uri: 'content://docs/b.md' }), '# 다른 문서');
        await settle();

        expect(sheet.hidden).toBe(true);
    });

    it('★ 진행 표시가 새 문서 위에 남지 않는다', async () => {
        /*
         * 청크가 둘 이상이어야 렌더가 '아직 도는 중'이 된다 —
         * 한 청크에 들어가면 show() 를 await 하는 동안 다 끝나 버려서
         * 애초에 표시가 켜져 있지 않다(TOKENS_PER_CHUNK = 600, 문단 하나가 약 3토큰).
         */
        const big = Array.from({ length: 400 }, (_, i) => `문단 ${i}`).join('\n\n');
        await screen.show(doc(), `# 큰 문서\n\n${big}`, { showProgress: true });

        const busy = screen.root.querySelector<HTMLElement>('.viewer-busy')!;
        expect(busy.hidden, '큰 문서인데 진행 표시가 안 떴다').toBe(false);

        /*
         * ★★ 다음 문서가 4MB 를 넘으면 plain 경로로 가는데, 그 경로는
         *   complete 를 기다리지 않고 곧바로 끝난다 — 표시를 꺼 줄 사람이 없다.
         *   앞 문서 것이 그대로 남아 **끝나지 않는 문서처럼 보인다.**
         */
        await screen.show(doc({ uri: 'content://docs/b.md' }), '아주 큰 원문', { plain: true });
        await settle();

        expect(busy.hidden).toBe(true);
    });

    it('앞 문서의 본문이 남지 않는다', async () => {
        await screen.show(doc(), '# 첫째 문서\n\n첫째 본문');
        await settle();
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('첫째 본문');

        await screen.show(doc({ uri: 'content://docs/b.md' }), '# 둘째 문서\n\n둘째 본문');
        await settle();

        const text = screen.root.querySelector('.md-target')?.textContent ?? '';
        expect(text).toContain('둘째 본문');
        expect(text).not.toContain('첫째 본문');
    });
});

describe('rerender — 같은 문서', () => {
    it('보기 설정 시트는 열어 둔 채로 다시 그린다', async () => {
        await screen.show(doc(), '# 문서\n\n본문');
        await settle();

        buttonByLabel(t.viewer.more)!.click();
        [...screen.root.querySelectorAll<HTMLElement>('.menu-item')]
            .find((b) => b.textContent === t.viewer.viewSettings)!
            .click();
        const sheet = document.querySelector<HTMLElement>('[aria-labelledby="view-title"]')!;
        expect(sheet.hidden).toBe(false);

        /*
         * ★ 여기서 시트를 닫으면 안 된다. 설정을 하나 바꿀 때마다 시트가 닫히면
         *   여러 개를 바꿔 보려는 사람이 매번 다시 열어야 한다.
         *   갈아타기(show)와 다시 그리기(rerender)는 서로 다르다.
         */
        await screen.rerender();
        await settle();

        expect(sheet.hidden).toBe(false);
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('본문');
    });
});

describe('★ 문서 안 링크로 뛸 때', () => {
    /**
     * ★★ AI 가 만든 문서는 맨 위에 목차 링크를 붙이는 경우가 아주 흔하다.
     *   그걸 누르면 jumpToAnchor 가 renderRest() 를 부른다 —
     *   목차 시트·검색과 **똑같이 무거운 작업**이다(2.5MB 에서 화면이 2초 멎는 것을 실측).
     *   그런데 저 둘만 진행 표시를 띄우고 링크만 맨 handle 을 받아 조용히 굳었다.
     */
    function bigDocWithTocLink(): string {
        const body = Array.from({ length: 400 }, (_, i) => `문단 ${i}`).join('\n\n');
        return `# 큰 문서\n\n[맺음말로](#맺음말)\n\n${body}\n\n## 맺음말\n\n끝입니다.\n`;
    }

    it('진행 표시를 띄운다', async () => {
        /*
         * ★ settle() 로 다 그린 뒤에 누르면 안 된다. 목표 제목이 이미 붙어 있어서
         *   renderRest 를 아예 안 부르고, 그러면 이 테스트가 아무것도 안 본다.
         *   show() 직후는 첫 청크만 붙어 있는 상태다 — 그때가 사용자가 링크를 보는 시점이다.
         */
        await screen.show(doc(), bigDocWithTocLink(), {});

        const busy = screen.root.querySelector<HTMLElement>('.viewer-busy')!;
        expect(busy.hidden, '아직은 떠 있으면 안 된다').toBe(true);
        expect(
            screen.root.querySelector('.md-target h2'),
            '맺음말이 벌써 붙었다 — 문서를 더 크게 잡아라',
        ).toBeNull();

        const link = screen.root.querySelector<HTMLAnchorElement>('.md-target a[href^="#"]');
        expect(link, '문서 안 링크가 없다').not.toBeNull();

        link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(0);

        expect(busy.hidden, '문서 안 링크만 아무 표시 없이 굳는다').toBe(false);
        expect(busy.textContent).toBe(t.viewer.renderingAll);

        await settle();
        expect(busy.hidden, '다 붙었으면 꺼져야 한다').toBe(true);
    });

    it('목표 제목까지 붙이고 나서 뛴다', async () => {
        await screen.show(doc(), bigDocWithTocLink(), {});

        const link = screen.root.querySelector<HTMLAnchorElement>('.md-target a[href^="#"]')!;
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();

        // 남은 청크를 안 붙이면 갈 곳이 없어 아무 일도 안 일어난다.
        expect(screen.root.querySelector('.md-target h2'), '남은 청크가 안 붙었다').not.toBeNull();
    });
});

/**
 * ★★★ 2026-08-06. '보이는 대로 공유' 는 문서를 **청크 없이 통째로** 다시 그린다.
 *
 *   실측 (1MB 평범한 문서, 데스크톱 크로뮴):
 *       렌더 519ms + 살균 855ms + 글자로 바꾸기 573ms = **1,948ms**
 *   폰이면 6~10초다. 확인 상자를 닫자마자 화면이 그만큼 굳는데 아무 표시가 없으면
 *   사용자는 앱이 멎은 줄 알고 강제 종료한다.
 *
 *   ★ 뷰어 안에는 withBusy 가 이미 있었지만 **뷰어 밖에서는 쓸 수 없었다.**
 *     "renderRest 를 부르는 모든 곳이 표시를 받아야 한다" 는 규칙이 이미 있는데,
 *     공유는 renderRest 가 아니라서 그 규칙의 그물을 빠져나갔다.
 */
describe('★★ withBusy — 뷰어 밖에서도 쓴다', () => {
    it('표시를 켜고, 일이 끝나면 끈다', async () => {
        await screen.show(doc(), '# 가\n\n나\n', {});
        const busy = screen.root.querySelector<HTMLElement>('.viewer-busy')!;
        expect(busy.hidden).toBe(true);

        let 도중표시: boolean | null = null;
        const p = screen.withBusy('만드는 중', () => {
            도중표시 = busy.hidden;
            return '결과';
        });

        await vi.advanceTimersByTimeAsync(50);
        expect(await p).toBe('결과');
        expect(도중표시, '일이 도는 동안 표시가 꺼져 있었다').toBe(false);
        expect(busy.hidden, '끝났는데 표시가 남았다').toBe(true);
    });

    it('★ 표시가 화면에 그려진 뒤에 시작한다', async () => {
        // 바로 fn() 을 부르면 메인 스레드가 잡혀 표시가 영영 안 그려진다.
        await screen.show(doc(), '# 가\n', {});
        const busy = screen.root.querySelector<HTMLElement>('.viewer-busy')!;

        let 시작됨 = false;
        const p = screen.withBusy('만드는 중', () => {
            시작됨 = true;
        });

        expect(시작됨, '프레임을 안 기다리고 바로 시작했다').toBe(false);
        expect(busy.hidden, '표시부터 켜져 있어야 한다').toBe(false);
        expect(busy.textContent).toBe('만드는 중');

        await vi.advanceTimersByTimeAsync(50);
        await p;
        expect(시작됨).toBe(true);
    });

    it('일이 터져도 표시를 끄고 그대로 던진다', async () => {
        await screen.show(doc(), '# 가\n', {});
        const busy = screen.root.querySelector<HTMLElement>('.viewer-busy')!;

        /*
         * ★ 거부를 **띄우는 즉시** 받아 둔다. 타이머를 먼저 돌리면 그사이 거부가
         *   처리되지 않은 채로 떠서 vitest 가 "unhandled rejection" 을 올린다 —
         *   그 상태에서는 다른 파일의 진짜 실패가 이 소음에 섞여 묻힌다.
         */
        const 던진다 = expect(
            screen.withBusy('만드는 중', () => {
                throw new Error('실패');
            }),
        ).rejects.toThrow('실패');
        await vi.advanceTimersByTimeAsync(50);
        await 던진다;
        expect(busy.hidden, '터진 뒤에 표시가 남으면 화면이 영영 가려진다').toBe(true);
    });
});

/**
 * ★★★ 2026-08-06. **기다리는 사이에 들어온 문서를 앞 문서가 지웠다.**
 *
 *   render() 한가운데에 await 가 있다 — 수식(KaTeX 396KB)·하이라이트 청크 받기다.
 *   그 사이에 다른 문서가 들어오면 앞 문서의 render() 가 나중에 깨어나
 *   **뒤에 온 문서를 지우고 자기를 그린다.** renderProgressive 가 맨 먼저
 *   container.replaceChildren() 을 하기 때문이다.
 *   결과: 화면에는 앞 문서가 뜨는데 **제목 줄에는 뒤 문서 이름**이 남는다.
 *
 *   ★★ 밟기 쉽다. KaTeX 는 모바일 데이터에서 몇 초씩 걸리고,
 *     looksLikeMath 는 **가격 문장('$5 … $3')에도 참**이라 수식 없는 문서도 받는다.
 *     그 몇 초 사이에 카톡에서 다른 .md 를 누르면 그대로 어긋난다 —
 *     그리고 문서를 갈아타는 길은 사실상 그 인텐트 하나뿐이다.
 *
 *   home.ts 의 refreshSeq 와 같은 함정인데, 그쪽만 고쳐져 있었다.
 */
describe('★★ 청크를 받는 사이에 문서가 바뀌면', () => {
    afterEach(() => {
        h.mathDelayMs = 0;
    });

    it('★ 앞 문서가 뒤에 온 문서를 지우지 않는다', async () => {
        h.mathDelayMs = 50;

        // A: 수식이 있어 청크를 기다린다
        const a = screen.show(doc({ name: 'a.md' }), '# 앞문서\n\n수식 $x^2$ 가 있다\n', {});
        await vi.advanceTimersByTimeAsync(10);

        // B: 수식이 없어 곧바로 그려진다
        h.mathDelayMs = 0;
        await screen.show(doc({ uri: 'content://docs/b.md', name: 'b.md' }), '# 뒷문서\n', {});
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('뒷문서');

        // A 의 청크가 뒤늦게 도착한다
        await vi.advanceTimersByTimeAsync(200);
        await a;
        await settle();

        const 본문 = screen.root.querySelector('.md-target')?.textContent ?? '';
        expect(본문, '앞 문서가 화면을 가로챘다').toContain('뒷문서');
        expect(본문, '앞 문서의 본문이 남았다').not.toContain('앞문서');
    });

    it('★ 제목과 본문이 어긋나지 않는다', async () => {
        h.mathDelayMs = 50;
        const a = screen.show(doc({ name: 'a.md' }), '# 앞문서\n\n$x^2$\n', {});
        await vi.advanceTimersByTimeAsync(10);

        h.mathDelayMs = 0;
        await screen.show(doc({ uri: 'content://docs/b.md', name: 'b.md' }), '# 뒷문서\n', {});
        await vi.advanceTimersByTimeAsync(200);
        await a;
        await settle();

        expect(screen.root.querySelector('.topbar-title')?.textContent).toBe('b.md');
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('뒷문서');
    });

    it('앞 문서의 frontmatter 가 뒤 문서 위에 남지 않는다', async () => {
        h.mathDelayMs = 50;
        const a = screen.show(doc({ name: 'a.md' }), '---\ntitle: 앞문서표\n---\n\n$x^2$\n', {});
        await vi.advanceTimersByTimeAsync(10);

        h.mathDelayMs = 0;
        await screen.show(doc({ uri: 'content://docs/b.md', name: 'b.md' }), '# 뒷문서\n', {});
        await vi.advanceTimersByTimeAsync(200);
        await a;
        await settle();

        expect(screen.root.textContent, '앞 문서의 접이식 표가 남았다').not.toContain('앞문서표');
    });

    it('갈아타지 않으면 수식 문서가 정상적으로 그려진다 (멈추는 조건이 과하지 않다)', async () => {
        h.mathDelayMs = 20;
        const p = screen.show(doc({ name: 'a.md' }), '# 앞문서\n\n$x^2$\n', {});
        await vi.advanceTimersByTimeAsync(200);
        await p;
        await settle();
        expect(screen.root.querySelector('.md-target')?.textContent).toContain('앞문서');
    });
});

/**
 * ★★★ 2026-08-06. **누르면 오류만 뜨는 [편집] 버튼이 보이고 있었다.**
 *
 *   openEditor 는 `!doc.uri` 면 곧바로 거부한다(예제 문서·공유받은 텍스트).
 *   그런데 버튼은 계속 보였다 — 사용자는 누르고 나서야 안 된다는 걸 안다.
 *   게다가 그 위 알림 줄은 **"편집하면 새 이름으로 저장하게 됩니다"** 라고
 *   약속하고 있었다. 실기 확인 결과 예제 문서에서:
 *       알림 줄 : "읽기 전용 문서입니다. 편집하면 새 이름으로 저장하게 됩니다."
 *       [편집]  : "편집할 수 없습니다 — 이 문서는 파일이 아니라 공유받은 텍스트입니다"
 *   **앱이 한 줄 위에서 한 약속을 바로 뒤집는다.** 게다가 예제 문서는
 *   '공유받은 텍스트' 도 아니라 문구 자체가 맞지 않았다.
 *
 *   ★ 예제 문서(welcome.md)는 원래부터 "편집 버튼이 나타나지 않습니다" 라고
 *     안내하고 있었다 — 즉 이게 처음부터의 의도였고 코드만 안 따라간 것이다.
 *   ★ ⋮ 메뉴의 '파일로 공유' 는 이미 같은 규칙(`!doc?.uri`)을 쓰고 있었다.
 *     한 화면 안에서 규칙이 갈라져 있었다.
 */
describe('★★ 파일이 아닌 문서에서는 [편집] 을 보여 주지 않는다', () => {
    function editBtn(): HTMLElement {
        return screen.root.querySelector<HTMLElement>(
            '.viewer-bar [aria-label="' + t.viewer.edit + '"]',
        )!;
    }
    function noticeText(): string {
        const n = screen.root.querySelector<HTMLElement>('.viewer-notice');
        return n && !n.hidden ? (n.textContent ?? '') : '';
    }

    it('★ URI 가 없는 문서(예제·공유받은 텍스트)에서는 숨긴다', async () => {
        await screen.show(doc({ uri: '', name: '공유된 텍스트', writable: false }), '# 가\n', {});
        expect(editBtn().hidden, '누르면 오류만 뜨는 버튼이 보인다').toBe(true);
    });

    it('★ 그때 "새 이름으로 저장" 을 약속하지 않는다', async () => {
        await screen.show(doc({ uri: '', name: '예제', writable: false }), '# 가\n', {});
        expect(noticeText(), '지키지 못할 약속이 떠 있다').not.toContain(t.viewer.readOnlyNotice);
    });

    it('진짜 파일이면 읽기 전용이어도 [편집] 을 보여 준다', async () => {
        await screen.show(doc({ writable: false }), '# 가\n', {});
        expect(editBtn().hidden).toBe(false);
        expect(noticeText()).toBe(t.viewer.readOnlyNotice);
    });

    it('쓸 수 있는 파일에서는 알림 줄이 없다', async () => {
        await screen.show(doc({ writable: true }), '# 가\n', {});
        expect(editBtn().hidden).toBe(false);
        expect(noticeText()).toBe('');
    });

    it('4MB 초과 원문 보기에서는 예전처럼 숨긴다 (회귀)', async () => {
        await screen.show(doc(), '아주 긴 글', { plain: true });
        expect(editBtn().hidden).toBe(true);
    });

    it('문서를 갈아타면 다시 나타난다 (한 번 숨기고 끝이 아니다)', async () => {
        await screen.show(doc({ uri: '', name: '예제' }), '# 가\n', {});
        expect(editBtn().hidden).toBe(true);
        await screen.show(doc(), '# 나\n', {});
        expect(editBtn().hidden).toBe(false);
    });
});

describe('★ 안내가 가리킬 자리 (coach)', () => {
    // 이름이 사라지면 안내가 조용히 반쪽이 된다 — home.test.ts 의 같은 시험과 짝이다.
    it.each(['toc', 'find', 'more'])('data-coach="%s" 가 상단 바에 있다', (name) => {
        expect(screen.root.querySelector(`[data-coach="${name}"]`)).not.toBeNull();
    });
});
