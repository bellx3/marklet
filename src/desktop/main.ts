// ★ CSS import 순서가 중요하다. utilities.css 가 반드시 마지막이다(11-3절).
import '../styles/base.css';
import '../styles/markdown.css';
import '../styles/hljs.css';
import '../styles/components.css';
import '../styles/desktop.css';
import '../styles/utilities.css';

import type { DesktopCommand, DesktopDoc } from './bridge';
import { loadSettings, getSettings, updateSettings } from '../services/settings';
import { createMarkdownIt } from '../markdown/renderer';
import { allowRelativeUrls } from '../markdown/sanitize';
import { parseDocument, renderFrontmatter } from '../markdown/frontmatter';
import {
    renderProgressive,
    renderPlainProgressive,
    type RenderHandle,
} from '../markdown/render-pipeline';
import { looksLikeMath, ensureMath } from '../markdown/math';
import { looksLikeCode, ensureHighlight } from '../markdown/highlight';
import { looksLikeMermaid, upgradeMermaidBlocks } from '../markdown/mermaid';
import { bindFitToWidth } from '../markdown/fit-width';
import { bindDocumentLinks } from '../app/screens/viewer';
import { bindDiagramZoom } from '../app/screens/diagram-viewer';
import { createTocSheet } from '../app/screens/toc-sheet';
import { createSearchBar } from '../app/screens/search-bar';
import { pressBack } from '../app/router';
import { localImageUrl } from './local-image';
import { createControls } from './controls';
import { t } from '../i18n';

/**
 * 데스크톱 뷰어 — 문서 하나를 그리는 화면 하나.
 *
 * 모바일 viewer-screen.ts 에서 **화면 틀(상단 바 · 메뉴 · 시트)은 버리고** 그리는 부분만 가져왔다.
 * 파싱·렌더·수식·코드·다이어그램·표 맞춤은 같은 모듈이다. 그래서 모바일에서 고친 것이
 * 여기서도 그대로 고쳐진다.
 */

/** 4MB 를 넘으면 서식 없이 원문만. Chromium 의 scrollHeight 상한(2^25px) 때문이다 — 모바일과 같다. */
const PLAIN_LIMIT = 4 * 1024 * 1024;

const bridge = window.marklet;

async function boot(): Promise<void> {
    // 같은 폴더의 그림과 다른 .md 를 가리키는 상대 주소를 살린다. 모바일은 켜지 않는다(sanitize.ts).
    allowRelativeUrls(true);
    await loadSettings();

    const app = document.querySelector<HTMLElement>('#app')!;
    app.classList.add('desktop');

    const empty = document.createElement('p');
    empty.className = 'desktop-empty';
    empty.textContent = t.desktop.emptyHint;

    const body = document.createElement('main');
    body.className = 'md-body';
    body.hidden = true;
    const frontmatterSlot = document.createElement('div');
    const target = document.createElement('div');
    target.className = 'md-target';
    body.append(frontmatterSlot, target);

    let handle: RenderHandle | null = null;
    let current: DesktopDoc | null = null;
    let showSource = false;
    /** 렌더가 await 를 지나는 동안 다른 문서가 들어오면 앞 것은 물러난다 */
    let seq = 0;

    const toc = createTocSheet(target, () => handle);
    const search = createSearchBar(target, () => handle);

    /*
     * 떠오르는 컨트롤. 명령은 메뉴·단축키와 **같은 command()** 로 간다 — 길이 둘이면 어긋난다.
     * 검색 바나 목차가 열려 있을 때는 그 위를 덮지 않는다(search 바가 우상단까지 차지한다).
     */
    const controls = createControls({
        onToc: () => command({ name: 'toc' }),
        onFind: () => command({ name: 'find' }),
        // 지금 어두우면 밝게, 아니면 어둡게. 메뉴의 라디오와 같은 저장소(메인)를 쓴다.
        onTheme: () =>
            bridge?.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
        onMore: () => bridge?.showMenu(),
        suppressed: () => search.isOpen || !!document.querySelector('.sheet-backdrop.is-open'),
    });
    app.append(search.root, empty, body, controls.root);

    bindDocumentLinks(target, () => handle);
    bindDiagramZoom(target);
    bindFitToWidth(target);

    /*
     * 문서 안의 상대 링크(다른 .md)는 메인이 연다. bindDocumentLinks 는 http(s) 와 #앵커만
     * 처리하고 나머지는 무시하므로 겹치지 않는다.
     */
    target.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement)?.closest?.('a');
        const href = a?.getAttribute('href') ?? '';
        if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
        e.preventDefault();
        bridge?.openLink(href);
    });

    /*
     * 상대 경로 그림을 문서 폴더 기준의 안전한 주소로 바꾼다.
     * ★ 청크가 프레임마다 나중에 붙으므로 한 번 훑고 끝낼 수 없다. 붙는 대로 본다.
     */
    const fixImages = (root: ParentNode): void => {
        if (!current) return;
        for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
            const url = localImageUrl(img.getAttribute('src') ?? '', current.dir);
            if (url) img.setAttribute('src', url);
        }
    };
    new MutationObserver((records) => {
        for (const r of records) {
            for (const n of Array.from(r.addedNodes)) {
                if (n.nodeType === 1) fixImages(n as HTMLElement);
            }
        }
    }).observe(target, { childList: true, subtree: true });

    async function show(doc: DesktopDoc): Promise<void> {
        const mine = ++seq;
        handle?.cancel();
        search.close();
        const y = doc.reload ? window.scrollY : 0;

        current = doc;
        controls.setActive(true);
        empty.hidden = true;
        body.hidden = false;
        frontmatterSlot.replaceChildren();

        if (showSource || doc.size > PLAIN_LIMIT) {
            handle = renderPlainProgressive(doc.content, target);
        } else {
            const { frontmatter, body: markdown } = parseDocument(doc.content);
            const md = createMarkdownIt({ breaks: getSettings().breaks });
            // 문서에 실제로 있을 때만 받는다. 나란히 기다린다(모바일과 같은 이유).
            await Promise.all([
                looksLikeMath(markdown) ? ensureMath(md) : null,
                looksLikeCode(markdown) ? ensureHighlight(md) : null,
            ]);
            if (mine !== seq) return;

            if (frontmatter) frontmatterSlot.appendChild(renderFrontmatter(frontmatter));
            try {
                handle = renderProgressive(md, markdown, target);
            } catch (err) {
                console.error('렌더 실패, 원문으로 폴백:', err);
                handle = renderPlainProgressive(markdown, target);
            }
            const mermaid = looksLikeMermaid(markdown);
            void handle.complete.then(() => {
                if (mine === seq && mermaid) void upgradeMermaidBlocks(target);
            });
        }

        if (doc.reload) {
            // 읽던 자리로 돌아간다. 청크가 아직 다 안 붙었으면 그 자리가 없으므로 다 붙인 뒤에.
            await handle.renderRest();
            if (mine === seq) window.scrollTo(0, y);
        } else {
            window.scrollTo(0, 0);
        }
    }

    async function printDoc(): Promise<void> {
        // 인쇄는 문서 전체여야 한다. 안 붙은 청크는 쪽에 안 나온다.
        await handle?.renderRest();
        // 어두운 테마로 인쇄하면 잉크를 쏟는다. 인쇄하는 동안만 밝게.
        const prev = document.documentElement.dataset.theme;
        document.documentElement.dataset.theme = 'light';
        window.addEventListener(
            'afterprint',
            () => {
                if (prev) document.documentElement.dataset.theme = prev;
            },
            { once: true },
        );
        window.print();
    }

    function command(cmd: DesktopCommand): void {
        switch (cmd.name) {
            case 'toc':
                if (current) toc.open(handle?.headings ?? []);
                break;
            case 'find':
                if (current) void search.open();
                break;
            case 'source':
                if (!current) break;
                showSource = !showSource;
                void show({ ...current, reload: true });
                break;
            case 'print':
                if (current) void printDoc();
                break;
            case 'settings': {
                const prevRemote = getSettings().remoteImages;
                void updateSettings({
                    theme: cmd.value.theme,
                    remoteImages: cmd.value.remoteImages,
                }).then(() => {
                    // 원격 이미지 정책은 렌더 단계에서 적용되므로 바뀌면 다시 그려야 한다.
                    if (current && prevRemote !== cmd.value.remoteImages) {
                        void show({ ...current, reload: true });
                    }
                });
                break;
            }
        }
    }

    /*
     * Esc = 뒤로가기. 열려 있는 목차·찾기·다이어그램 확대를 위에서부터 하나씩 닫는다.
     * ★ 모바일은 initRouter() 가 안드로이드 뒤로가기 버튼을 건다. 데스크톱에는 그 버튼이
     *   없으므로 라우터는 초기화하지 않고 스택(pushLayer)만 그대로 쓴다.
     */
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.isComposing) void pressBack();
    });

    // 파일을 창에 끌어다 놓으면 연다.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) bridge?.openPath(file);
    });
    // Ctrl+휠 확대. Chromium 은 이걸 대신 해 주지 않는다.
    window.addEventListener(
        'wheel',
        (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            bridge?.zoom(e.deltaY < 0 ? 1 : -1);
        },
        { passive: false },
    );

    bridge?.onDocument((doc) => void show(doc));
    bridge?.onCommand(command);
    bridge?.ready();
}

void boot().catch((err) => {
    console.error('부팅 실패:', err);
    document.body.textContent = String(err?.message ?? err);
});
