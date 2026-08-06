import type { MdDocument } from '../../plugins/md-file';
import { parseDocument, renderFrontmatter } from '../../markdown/frontmatter';
import { createMarkdownIt } from '../../markdown/renderer';
import {
    renderProgressive,
    renderPlainProgressive,
    type RenderHandle,
} from '../../markdown/render-pipeline';
import { looksLikeMath, ensureMath } from '../../markdown/math';
import { looksLikeCode, ensureHighlight } from '../../markdown/highlight';
import { looksLikeMermaid, upgradeMermaidBlocks } from '../../markdown/mermaid';
import { bindDocumentLinks } from './viewer';
import { bindDiagramZoom, closeDiagramViewer } from './diagram-viewer';
import { createTocSheet, type TocSheet } from './toc-sheet';
import { createSearchBar, type SearchBar } from './search-bar';
import { createViewSheet, type ViewSheet } from './view-sheet';
import { getSettings } from '../../services/settings';
import { iconButton } from '../icons';
import { t } from '../../i18n';
import { mark, measure, record } from '../../utils/perf';

/**
 * S1 뷰어 화면.
 *
 * ★ 뒤로가기는 진입 출처에 따라 갈린다(9-1절). 그 판단은 shell 이 하고
 *   여기서는 onBack 콜백만 부른다 — 화면이 자기 뒤 화면을 알면 안 된다.
 */

export interface ViewerCallbacks {
    onBack(): void;
    onEdit(): void;
    onSettings(): void;
    onPickFile(): void;
    /** 마크다운 원문을 글자 그대로 (5-8절) */
    onShare(): void;
    /** 화면에 보이는 대로 — 기호를 걷어낸 읽기 좋은 글자 (5-8절) */
    onSharePlain(): void;
    /** 원본 파일 자체를 (5-8절). URI 가 없는 문서에서는 메뉴가 숨겨진다 */
    onShareFile(): void;
}

export interface ViewerOptions {
    /** 4MB 초과 — 서식 없이 원문만 */
    plain?: boolean;
    /** 원본을 못 열어 앱이 보관한 사본을 보고 있다 */
    fromSnapshot?: boolean;
    /** 512KB 초과 — 배경 렌더가 도는 동안 진행 표시를 띄운다(5-5절) */
    showProgress?: boolean;
}

export interface ViewerScreen {
    root: HTMLElement;
    show(doc: MdDocument, content: string, opts?: ViewerOptions): Promise<void>;
    /** 설정(breaks·원격 이미지)이 바뀌었을 때 같은 문서를 다시 그린다. */
    rerender(): Promise<void>;
    /** 문서를 갈아탈 때·화면을 떠날 때 열려 있는 것들을 전부 닫는다. */
    closeOverlays(): void;
    getDoc(): MdDocument | null;
    getContent(): string;
    getHandle(): RenderHandle | null;
    setContent(content: string): void;
    /**
     * 진행 표시를 켠 채로 오래 걸리는 일을 한다.
     *
     * ★★ 뷰어 **밖에서도** 쓸 수 있어야 한다. '보이는 대로 공유' 는 문서를 한 번 더
     *   통째로 그리는데(청크 없이), 1MB 에 데스크톱 2초·폰 6~10초다.
     *   그동안 아무 표시가 없으면 사용자는 앱이 멎은 줄 안다(2026-08-06 실측).
     */
    withBusy<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
    destroy(): void;
}

export function createViewerScreen(cb: ViewerCallbacks): ViewerScreen {
    const root = document.createElement('div');
    root.className = 'screen screen-viewer';

    // ── 상단 바
    const bar = document.createElement('div');
    bar.className = 'app-topbar viewer-bar';

    const back = iconButton('back', t.common.back, cb.onBack);
    const title = document.createElement('h1');
    title.className = 'topbar-title topbar-title--doc';

    /*
     * ★ 바에 두는 버튼은 네 개까지다.
     *   2026-08-04 실기기(411px)에서 여섯 개를 뒀더니 제목이 '한글…' 로 잘렸다.
     *   48px × 6 = 288px 가 제목 자리를 먹은 것이다. 이름이 안 보이는 문서 뷰어는 곤란하다.
     *   → 읽는 동안 손이 가는 것(목차·찾기·편집)만 남기고 나머지는 ⋮ 로 내린다.
     */
    const tocBtn = iconButton('list', t.viewer.toc, () => toc.open(handle?.headings ?? []));
    const searchBtn = iconButton('search', t.viewer.find, () => void search.open());
    const editBtn = iconButton('pencil', t.viewer.edit, cb.onEdit);
    const moreBtn = iconButton('more', t.viewer.more, () => setMenu(more.hidden));
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');

    bar.append(back, title, tocBtn, searchBtn, editBtn, moreBtn);

    /*
     * ── ⋮ 메뉴 (아주 작아서 시트를 따로 만들지 않는다)
     *
     * ★★ 상단 바의 **자식**이다. 형제로 두면 안 된다 —
     *   형제일 때는 메뉴가 문서 흐름에 끼어서 **열릴 때마다 본문을 아래로 밀어낸다**
     *   (2026-08-04 사용자가 지적한 그것). 그렇다고 화면 기준으로 absolute 를 걸면
     *   바는 스크롤에 붙어 있는데 메뉴만 위로 올라가 버린다.
     *   상단 바는 sticky — 즉 **위치 지정된 조상**이므로, 그 안에 넣으면
     *   메뉴가 바를 따라다니면서 본문 위에 겹쳐 뜬다.
     */
    const more = document.createElement('div');
    more.className = 'more-menu';
    more.setAttribute('role', 'menu');
    more.hidden = true;

    /*
     * 메뉴 밖을 누르면 닫힌다. 본문에만 pointerdown 을 걸면
     * 상단 바·알림 줄을 눌렀을 때 메뉴가 그대로 남는다. 화면 전체를 덮는다.
     */
    const scrim = document.createElement('div');
    scrim.className = 'menu-scrim';
    scrim.hidden = true;
    scrim.addEventListener('pointerdown', () => setMenu(false));

    function setMenu(open: boolean): void {
        more.hidden = !open;
        scrim.hidden = !open;
        moreBtn.setAttribute('aria-expanded', String(open));
    }

    // 공유 3형태 (5-8절). 받는 사람이 무엇을 보게 되는지가 라벨에 드러나야 한다.
    const shareFileItem = menuItem(t.viewer.shareFile, () => cb.onShareFile());

    more.append(
        menuItem(t.viewer.viewSettings, () => viewSheet.open()),
        menuItem(t.viewer.openAnother, () => cb.onPickFile()),
        separator(),
        // ★ 파일 공유를 먼저 둔다. 받는 사람이 원문 대신 문서를 받는 쪽이 기대에 맞다(5-8절).
        //   파일이 아닌 문서(예제·공유받은 텍스트)에서는 열 때 숨긴다.
        shareFileItem,
        menuItem(t.viewer.sharePlain, () => cb.onSharePlain()),
        menuItem(t.viewer.shareSource, () => cb.onShare()),
        separator(),
        menuItem(t.common.settings, () => cb.onSettings()),
    );

    // 어느 항목을 눌러도 메뉴는 닫힌다. 항목마다 적지 않고 한 곳에서 처리한다.
    more.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.menu-item')) setMenu(false);
    });

    // ── 알림 줄 (사본 · 읽기 전용)
    const notice = document.createElement('div');
    notice.className = 'viewer-notice';
    notice.hidden = true;

    /*
     * ── 진행 표시.
     * ★ 큰 문서는 그리는 데 시간이 걸리고, 목차 점프는 남은 청크를 **한 번에** 붙이느라
     *   메인 스레드를 통째로 잡는다(3.6MB 에서 8초 실측). 아무 표시가 없으면
     *   사용자는 앱이 죽었다고 판단한다. 게이트의 showProgress 가 이걸 켠다.
     */
    const busy = document.createElement('div');
    busy.className = 'viewer-busy';
    busy.setAttribute('role', 'status');
    busy.setAttribute('aria-live', 'polite');
    busy.hidden = true;

    const body = document.createElement('main');
    body.className = 'md-body';

    const frontmatterSlot = document.createElement('div');
    const target = document.createElement('div');
    target.className = 'md-target';
    body.append(frontmatterSlot, target);

    // ★ 메뉴와 스크림은 바 **안에** 넣는다(위 주석). 바깥으로 빼면 문서가 밀린다.
    bar.append(scrim, more);
    root.append(bar, notice, busy, body);

    // ── 오버레이들. 컨테이너가 고정이라 한 번만 만들면 된다.
    let handle: RenderHandle | null = null;

    /**
     * 표시를 켜고 **화면에 그려진 뒤** 일을 시작한다.
     * ★ 두 프레임을 기다리는 게 핵심이다. 바로 fn() 을 부르면 메인 스레드가 잡혀서
     *   표시가 영영 그려지지 않는다 — 있으나 마나 한 표시가 된다.
     */
    async function withBusy<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
        busy.textContent = label;
        busy.hidden = false;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        try {
            return await fn();
        } finally {
            busy.hidden = true;
        }
    }

    /**
     * renderRest 를 부르는 **모든** 곳이 이걸 받아야 한다 — 목차 · 검색 · 문서 안 링크.
     * ★ 하나라도 맨 handle 을 받으면 그 경로만 아무 표시 없이 몇 초씩 굳는다.
     */
    const getHandleWithBusy = (): RenderHandle | null => {
        if (!handle) return null;
        const h = handle;
        return {
            ...h,
            renderRest: () => withBusy(t.viewer.renderingAll, () => h.renderRest()),
        };
    };

    const toc: TocSheet = createTocSheet(target, getHandleWithBusy);
    // ★ 검색 바는 상단 바 '아래 한 줄'이 아니라 상단 바를 **덮는다**(9-1절 T2).
    //   덧붙이기만 하면 검색 중에도 편집·목차 버튼이 눌려 오작동한다(2026-08-03 실측).
    const search: SearchBar = createSearchBar(target, getHandleWithBusy, (open) => {
        bar.hidden = open;
        if (open) setMenu(false);
    });
    const viewSheet: ViewSheet = createViewSheet(() => void screen.rerender());
    root.insertBefore(search.root, notice);

    // 위임이라 나중에 SVG 로 바뀌는 블록에도 걸린다. 한 번만 부르면 된다.
    /*
     * ★★ 여기도 **진행 표시가 붙은** 핸들이어야 한다. 예전에는 맨 handle 을 줬다.
     *
     *   문서 안 링크(#앵커)를 누르면 jumpToAnchor 가 renderRest() 를 부른다 —
     *   목차·검색과 **똑같이 무거운 작업**이다(2.5MB 문서에서 화면이 2초 멎는 것을 실측).
     *   그런데 저 둘만 표시를 띄우고 링크는 아무 표시 없이 굳었다.
     *
     *   AI 가 만든 문서는 맨 위에 목차 링크를 붙이는 경우가 아주 흔하다. 그걸 누른
     *   사용자는 몇 초 동안 아무 반응 없는 화면을 보고 "앱이 죽었다" 고 판단한다.
     *   각주 번호([1] · ↩︎)도 같은 경로다.
     */
    bindDocumentLinks(target, getHandleWithBusy);
    bindDiagramZoom(target);

    let doc: MdDocument | null = null;
    let content = '';
    let options: ViewerOptions = {};

    /**
     * 몇 번째 렌더인가.
     *
     * ★★★ render() 한가운데에 **await 가 있다**(수식·하이라이트 청크 받기).
     *   그 사이에 다른 문서가 들어오면 앞 문서의 render() 가 나중에 깨어나
     *   **뒤에 온 문서를 지우고 자기를 그린다** — renderProgressive 가 맨 먼저
     *   container.replaceChildren() 을 하기 때문이다. 화면에는 앞 문서가 뜨는데
     *   제목 줄에는 뒤 문서 이름이 남는다.
     *
     *   밟기 쉽다: KaTeX 는 396KB 라 모바일 데이터에서 몇 초씩 걸리고,
     *   looksLikeMath 는 **가격 문장('$5 … $3')에도 참**이라 수식 없는 문서도 받는다.
     *   그 몇 초 사이에 카톡에서 다른 .md 를 누르면 그대로 어긋난다.
     *
     *   home.ts 의 refreshSeq 와 같은 방식이다 — 그쪽은 이미 이 함정을 밟고 고쳤는데
     *   여기는 그대로였다.
     */
    let renderSeq = 0;

    async function render(): Promise<void> {
        const seq = ++renderSeq;
        closeDiagramViewer();
        search.close();
        handle?.cancel();
        frontmatterSlot.replaceChildren();

        /*
         * ★★ 표시를 반드시 여기서 끈다.
         *   켜는 조건(showProgress)과 끄는 조건(complete.then)이 서로 다른 자리에 있어서,
         *   **끄는 쪽이 아예 실행되지 않는 경로**가 있다. 512KB 문서를 그리는 중에
         *   4MB 넘는 문서로 갈아타면 새 문서는 plain 경로라 complete 를 기다리지 않고
         *   곧바로 끝난다 — 앞 문서의 "그리는 중" 이 그대로 남아
         *   **끝나지 않는 문서처럼 보인다.** 켜기 전에 끄면 그 갈래가 사라진다.
         */
        busy.hidden = true;

        title.textContent = doc?.name ?? 'Marklet';

        // 알림 줄 — ★ 사용자가 사본을 편집하고 저장했다고 믿게 두면 그게 곧 데이터 유실이다.
        if (options.fromSnapshot) {
            notice.hidden = false;
            notice.textContent = t.viewer.snapshotNotice;
        } else if (doc && !doc.writable) {
            notice.hidden = false;
            notice.textContent = t.viewer.readOnlyNotice;
        } else {
            notice.hidden = true;
            notice.textContent = '';
        }
        editBtn.hidden = !!options.plain;
        // ★ 파일 공유는 진짜 파일일 때만. 예제 문서·공유받은 텍스트는 URI 가 없고,
        //   사본을 보고 있을 때는 원본이 아니라 사본을 보내게 되므로 숨긴다.
        shareFileItem.hidden = !doc?.uri || !!options.fromSnapshot;

        if (options.plain) {
            // ★ 여기서 markdown-it 을 부르면 안 된다. 그 크기를 감당 못 해서 이 경로로 왔다.
            handle = renderPlainProgressive(content, target);
            return;
        }

        // 1. frontmatter 분리 (6-8절)
        const { frontmatter, body: markdown } = parseDocument(content);
        const md = createMarkdownIt({ breaks: getSettings().breaks });

        /*
         * 2. ★ 무거운 것들은 parse 전에 붙인다. 렌더 도중이면 앞 청크에 안 들어간다.
         *   둘 다 문서에 실제로 있을 때만 받는다 — 코드 없는 문서는 hljs 를 아예 안 받는다.
         *   ★ 나란히 기다린다. 순서대로 await 하면 둘 다 있는 문서에서 두 배로 늦다.
         */
        await Promise.all([
            looksLikeMath(markdown) ? ensureMath(md) : null,
            looksLikeCode(markdown) ? ensureHighlight(md) : null,
        ]);

        /*
         * ★★★ 기다리는 동안 다른 문서가 들어왔으면 **여기서 멈춘다**(renderSeq 주석).
         *   아래 renderProgressive 는 맨 먼저 container 를 비우므로, 그냥 두면
         *   뒤에 온 문서를 지우고 앞 문서를 그린다 — 제목만 뒤 문서인 채로.
         */
        if (seq !== renderSeq) return;

        if (frontmatter) frontmatterSlot.appendChild(renderFrontmatter(frontmatter));

        // 3. 렌더. 실패하면 화면이 비지 않도록 원문으로 폴백한다(14-3절).
        mark('doc:parse');
        try {
            handle = renderProgressive(md, markdown, target);
        } catch (err) {
            console.error('렌더 실패, 원문으로 폴백:', err);
            handle = renderPlainProgressive(markdown, target);
            return;
        }
        measure('doc:first-chunk', 'doc:parse');

        // 4. 512KB 를 넘으면 배경 렌더가 도는 동안 표시를 띄운다(5-5절 showProgress).
        //    첫 화면은 이미 떠 있으므로 읽기를 막지는 않는다.
        if (options.showProgress) {
            busy.textContent = t.viewer.renderingDoc;
            busy.hidden = false;
        }

        const t0 = performance.now();
        const current = handle;
        void handle.complete.then(() => {
            record('doc:complete', performance.now() - t0);
            // 그 사이 다른 문서로 갈아탔으면 이 표시는 남의 것이다. 건드리지 않는다.
            if (handle === current) busy.hidden = true;
            // 5. 본문을 먼저 읽을 수 있게 한 뒤에 다이어그램을 올린다.
            if (looksLikeMermaid(markdown)) void upgradeMermaidBlocks(target);
        });
    }

    const screen: ViewerScreen = {
        root,
        async show(nextDoc, nextContent, opts = {}) {
            /*
             * ★★ 갈아타기 전에 열려 있는 것을 전부 닫는다.
             *   뷰어는 컨테이너를 재사용하므로 시트·메뉴는 문서가 바뀌어도 그대로 떠 있다.
             *   목차 시트가 남으면 **앞 문서의 제목들이 새 문서의 목차인 척** 보이고,
             *   눌러도 그 id 가 없어 아무 일도 안 일어난다. back 스택에도 'toc' 가 남아
             *   뒤로가기 한 번을 화면에 없는 시트가 먹는다(9-4절).
             *
             *   ★ 앱 안에서는 시트를 닫아야만 다른 문서로 갈 수 있어서 손으로는 잘 안 나온다.
             *     밖에서 들어오는 인텐트(카톡의 .md)는 그 순서를 지키지 않는다.
             *
             *   ★ rerender 에는 걸지 않는다. 보기 설정 시트가 자기 자신을 다시 그리게 하는데,
             *     거기서 닫아 버리면 설정을 하나 바꿀 때마다 시트가 사라진다.
             */
            screen.closeOverlays();

            doc = nextDoc;
            content = nextContent;
            options = opts;
            body.scrollTop = 0;
            window.scrollTo(0, 0);
            await render();
        },
        rerender: () => render(),
        closeOverlays() {
            toc.close();
            search.close();
            viewSheet.close();
            closeDiagramViewer();
            setMenu(false);
        },
        getDoc: () => doc,
        getContent: () => content,
        getHandle: () => handle,
        setContent(next) {
            content = next;
        },
        withBusy,
        destroy() {
            handle?.cancel();
            toc.destroy();
            viewSheet.destroy();
            search.close();
        },
    };

    return screen;
}

function menuItem(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

/** 메뉴 묶음 구분선. 항목마다 줄을 그으면 목록이 격자처럼 보인다. */
function separator(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'menu-sep';
    el.setAttribute('role', 'separator');
    return el;
}
