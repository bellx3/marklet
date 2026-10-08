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
import { bindDocumentLinks, jumpToAnchor } from '../app/screens/viewer';
import { bindDiagramZoom } from '../app/screens/diagram-viewer';
import { createTocSheet } from '../app/screens/toc-sheet';
import { createSearchBar } from '../app/screens/search-bar';
import { pressBack } from '../app/router';
import { Toast } from '../utils/toast';
import { localImageUrl } from './local-image';
import { createControls } from './controls';
import { createPopupMenu, type MenuEntry } from './popup-menu';
import { createTocDock } from './toc-dock';
import { isPlainTextName, normalizeNewlines } from './doc-kind';
import { t } from '../i18n';

/**
 * 데스크톱 뷰어 — 문서 하나를 그리는 화면 하나.
 *
 * 모바일 viewer-screen.ts 에서 **화면 틀(상단 바 · 메뉴 · 시트)은 버리고** 그리는 부분만 가져왔다.
 * 파싱·렌더·수식·코드·다이어그램·표 맞춤은 같은 모듈이다. 그래서 모바일에서 고친 것이
 * 여기서도 그대로 고쳐진다.
 *
 * 글은 세 곳에 있다.
 *   saved  — 파일에 있는 그대로(마지막으로 읽거나 쓴 것)
 *   draft  — 지금 화면의 글. 편집하면 saved 와 달라지고, 그 차이가 '저장하지 않은 편집'이다
 *   편집기 — 편집 중에만 draft 를 들고 있다가 나갈 때 돌려준다
 */

/** 4MB 를 넘으면 서식 없이 원문만. Chromium 의 scrollHeight 상한(2^25px) 때문이다 — 모바일과 같다. */
const PLAIN_LIMIT = 4 * 1024 * 1024;

const bridge = window.marklet;

async function boot(): Promise<void> {
    // 문서 폴더 기준 상대 주소(그림 · 다른 .md 로 거는 링크)를 살린다(sanitize.ts).
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

    const editor = document.createElement('textarea');
    editor.className = 'desktop-editor';
    editor.hidden = true;
    editor.spellcheck = false;
    editor.setAttribute('aria-label', t.viewer.edit);

    let handle: RenderHandle | null = null;
    let current: DesktopDoc | null = null;
    let showSource = false;
    let editing = false;
    /** 파일에 있는 그대로(LF). 마지막으로 읽거나 쓴 것이다. */
    let saved = '';
    /** 지금 화면의 글(LF). saved 와 다르면 저장하지 않은 편집이다. */
    let draft = '';
    let reportedDirty = false;
    /** 렌더가 await 를 지나는 동안 다른 문서가 들어오면 앞 것은 물러난다 */
    let seq = 0;

    const toc = createTocSheet(target, () => handle);
    const search = createSearchBar(target, () => handle);

    /*
     * 떠오르는 컨트롤. 명령은 메뉴·단축키와 **같은 command()** 로 간다 — 길이 둘이면 어긋난다.
     * 검색 바나 목차가 열려 있을 때는 그 위를 덮지 않는다(search 바가 우상단까지 차지한다).
     */
    const popup = createPopupMenu();
    /** 케밥 버튼과 우클릭이 같은 메뉴를 쓴다. 단축키를 항목 옆에 적어 둔다(메뉴 = 단축키 사전). */
    const menuEntries = (hasSelection: boolean): MenuEntry[] => {
        const doc = !!current;
        const reading = doc && !editing;
        const run = (name: 'edit' | 'toc' | 'find' | 'source' | 'print' | 'pdf') => () =>
            command({ name });
        const entries: MenuEntry[] = [];
        if (hasSelection) {
            entries.push({
                label: t.desktop.menuCopy,
                shortcut: 'Ctrl+C',
                onSelect: () => void document.execCommand('copy'),
            });
        }
        entries.push(
            {
                label: t.desktop.menuSelectAll,
                shortcut: 'Ctrl+A',
                disabled: !reading,
                onSelect: () => void document.execCommand('selectAll'),
            },
            'separator',
            { label: t.viewer.edit, shortcut: 'Ctrl+E', disabled: !doc, onSelect: run('edit') },
            { label: t.viewer.toc, shortcut: 'Ctrl+T', disabled: !reading, onSelect: run('toc') },
            { label: t.viewer.find, shortcut: 'Ctrl+F', disabled: !reading, onSelect: run('find') },
            {
                label: t.desktop.menuSource,
                shortcut: 'Ctrl+U',
                disabled: !reading,
                onSelect: run('source'),
            },
            'separator',
            { label: t.desktop.menuOpen, shortcut: 'Ctrl+O', onSelect: () => bridge?.run('open') },
            {
                label: t.desktop.menuPrint,
                shortcut: 'Ctrl+P',
                disabled: !reading,
                onSelect: run('print'),
            },
            {
                label: t.desktop.menuPdf,
                shortcut: 'Ctrl+Shift+P',
                disabled: !reading,
                onSelect: run('pdf'),
            },
        );
        return entries;
    };
    function toggleMenu(): void {
        if (popup.isOpen) {
            popup.close();
            return;
        }
        const kebab = controls.root.querySelector<HTMLElement>('.desktop-ctl:last-child');
        if (kebab) popup.open(menuEntries(false), { below: kebab });
    }
    // 글을 치는 곳(편집기 · 입력칸)은 네이티브 우클릭을 그대로 둔다 — 붙여넣기 · 맞춤법이 거기 있다.
    window.addEventListener('contextmenu', (e) => {
        if ((e.target as Element | null)?.closest('textarea, input')) return;
        e.preventDefault();
        popup.open(menuEntries(!(document.getSelection()?.isCollapsed ?? true)), {
            x: e.clientX,
            y: e.clientY,
        });
    });

    const controls = createControls({
        onEdit: () => command({ name: 'edit' }),
        onToc: () => command({ name: 'toc' }),
        onFind: () => command({ name: 'find' }),
        // 지금 어두우면 밝게, 아니면 어둡게. 메뉴의 라디오와 같은 저장소(메인)를 쓴다.
        onTheme: () =>
            bridge?.setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
        onMore: () => toggleMenu(),
        suppressed: () => search.isOpen || !!document.querySelector('.sheet-backdrop.is-open'),
    });
    /*
     * 목차 도크. 제목이 있는 문서에서 목차를 열면 왼쪽에 붙어 문서를 옆으로 민다.
     * 제목이 없는 문서는 아래 command('toc') 가 기존 안내 모달(toc 시트)을 그대로 쓴다.
     */
    const dock = createTocDock({
        host: app,
        container: target,
        onJump: (id) => void jumpToAnchor(id, target, handle),
    });
    app.append(dock.root, search.root, empty, body, editor, controls.root);

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

    /** 저장하지 않은 편집이 생기거나 사라질 때만 메인에 알린다(제목의 ● 와 닫을 때의 확인). */
    function reportDirty(): void {
        const dirty = draft !== saved;
        if (dirty === reportedDirty) return;
        reportedDirty = dirty;
        bridge?.setDirty(dirty);
    }

    /** 지금 draft 를 화면에 그린다. 읽던 자리를 지키려면 keepScroll. */
    async function render(keepScroll: boolean): Promise<void> {
        if (!current) return;
        const mine = ++seq;
        handle?.cancel();
        search.close();
        const y = keepScroll ? window.scrollY : 0;
        frontmatterSlot.replaceChildren();

        if (showSource || draft.length > PLAIN_LIMIT) {
            handle = renderPlainProgressive(draft, target);
        } else {
            const { frontmatter, body: markdown } = parseDocument(draft);
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

        // 제목 목록을 도크에 넘긴다. 서식 없이 보는 중이면 비어 있어 도크는 닫힌다.
        dock.setHeadings(handle.headings);

        if (keepScroll) {
            // 읽던 자리로 돌아간다. 청크가 아직 다 안 붙었으면 그 자리가 없으므로 다 붙인 뒤에.
            await handle.renderRest();
            if (mine === seq) window.scrollTo(0, y);
        } else {
            window.scrollTo(0, 0);
        }
    }

    /** 메인이 문서를 보냈다(열었거나, 다른 곳에서 바뀌어 다시 읽었다). */
    async function show(doc: DesktopDoc): Promise<void> {
        const text = normalizeNewlines(doc.content);
        const sameFile = doc.reload && current?.path === doc.path;
        current = doc;
        saved = text;
        draft = text;
        reportedDirty = false;
        controls.setActive(true);
        empty.hidden = true;

        if (!sameFile) {
            // 새 문서. .txt 는 마크다운이 아니므로 글자 그대로 보여 주는 쪽이 기본이다.
            showSource = isPlainTextName(doc.name);
            if (editing) {
                // ★ setEditing(false) 를 부르지 않는다 — 그건 편집기의 글을 draft 로 되돌려 주는데,
                //   그 글은 이전 문서의 것이다. 방금 받은 새 문서를 덮어쓴다.
                editing = false;
                controls.setEditing(false);
                editor.hidden = true;
                dock.suspend(false);
            }
        }

        if (editing) {
            // 편집 중에 디스크가 바뀌어 다시 읽었다(메인은 저장하지 않은 편집이 없을 때만 보낸다).
            editor.value = draft;
            return;
        }
        body.hidden = false;
        await render(sameFile);
    }

    /**
     * 편집 모드 ↔ 보기 모드.
     * 나갈 때 편집한 글(저장 전이어도)이 그대로 미리보기로 그려진다 — 저장은 따로 한다.
     */
    function setEditing(on: boolean, rerender = true): void {
        if (!current || on === editing) return;
        editing = on;
        controls.setEditing(on);
        controls.hide();
        if (on) {
            search.close();
            dock.suspend(true);
            editor.value = draft;
            body.hidden = true;
            editor.hidden = false;
            editor.focus();
            editor.setSelectionRange(0, 0);
        } else {
            draft = normalizeNewlines(editor.value);
            editor.hidden = true;
            body.hidden = false;
            dock.suspend(false);
            reportDirty();
            if (rerender) void render(false);
        }
    }

    editor.addEventListener('input', () => {
        draft = normalizeNewlines(editor.value);
        reportDirty();
    });
    // Tab 은 포커스를 옮기지 않고 들여쓴다. execCommand 로 넣어야 Ctrl+Z 가 한 번에 되돌린다.
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            document.execCommand('insertText', false, '\t');
        }
    });

    async function save(): Promise<void> {
        if (!current || !bridge) return;
        const snapshot = editing ? normalizeNewlines(editor.value) : draft;
        draft = snapshot;
        // 고친 게 없으면 쓰지 않는다. 안 쓰면 파일의 수정 시각이 그대로라 다른 도구가 헛돌지 않는다.
        if (snapshot === saved) return;
        const r = await bridge.save(snapshot);
        if (!r.ok) return;
        // 저장하는 동안 더 쳤을 수 있다. 보낸 그 글을 '저장된 것'으로 삼고 차이는 그대로 둔다.
        saved = snapshot;
        reportDirty();
        Toast.success(t.shell.saved);
    }

    async function printDoc(mode: 'preview' | 'pdf'): Promise<void> {
        // 인쇄는 문서 전체여야 한다. 안 붙은 청크는 쪽에 안 나온다.
        await handle?.renderRest();
        // 어두운 테마로 인쇄하면 잉크를 쏟는다. 인쇄하는 동안만 밝게.
        const prev = document.documentElement.dataset.theme;
        document.documentElement.dataset.theme = 'light';
        try {
            await bridge?.print(mode);
        } finally {
            if (prev) document.documentElement.dataset.theme = prev;
            else delete document.documentElement.dataset.theme;
        }
    }

    /**
     * 문서를 다 치우고 맨 처음 모습(안내 화면)으로 돌아간다.
     * Rust 가 마지막 창을 닫는 대신 숨겨 두었다가 다음 문서에 다시 쓸 때(빠른 시작) 보낸다. 이 창의 웹뷰는 이미 떠서 코드가 다 올라가 있으므로
     * 다음 문서는 부팅 없이 바로 그려진다 — 그러려면 앞 문서의 흔적(편집 · 찾기 · 목차 · 열린 확대 보기)이 하나도 남지 않아야 한다.
     */
    async function resetView(): Promise<void> {
        seq++; // 렌더가 await 를 지나는 중이면 물러난다
        handle?.cancel();
        handle = null;
        // 열려 있는 것(찾기 · 목차 · 다이어그램 확대)을 위에서부터 닫는다. 무한 루프를 막으려 상한을 둔다.
        for (let i = 0; i < 8 && (await pressBack()) !== null; i++);
        search.close();
        popup.close();
        if (editing) {
            editing = false;
            controls.setEditing(false);
            editor.hidden = true;
            dock.suspend(false);
        }
        editor.value = '';
        current = null;
        saved = '';
        draft = '';
        reportedDirty = false;
        showSource = false;
        frontmatterSlot.replaceChildren();
        target.replaceChildren();
        body.hidden = true;
        empty.hidden = false;
        dock.setHeadings([]);
        controls.setActive(false);
        window.scrollTo(0, 0);
    }

    function command(cmd: DesktopCommand): void {
        switch (cmd.name) {
            case 'reset':
                void resetView();
                break;
            case 'edit':
                if (current) setEditing(!editing);
                break;
            case 'save':
                void save();
                break;
            case 'toc':
                if (!current || editing) break;
                // 제목이 있으면 왼쪽 도크, 없으면 '제목이 없습니다' 안내 모달.
                if ((handle?.headings.length ?? 0) > 0) dock.toggle();
                else toc.open([]);
                break;
            case 'find':
                if (current && !editing) void search.open();
                break;
            case 'source':
                if (!current || editing) break;
                showSource = !showSource;
                void render(true);
                break;
            case 'print':
                if (current && !editing) void printDoc('preview');
                break;
            case 'pdf':
                if (current && !editing) void printDoc('pdf');
                break;
            case 'settings': {
                const prevRemote = getSettings().remoteImages;
                void updateSettings({
                    theme: cmd.value.theme,
                    remoteImages: cmd.value.remoteImages,
                }).then(() => {
                    // 원격 이미지 정책은 렌더 단계에서 적용되므로 바뀌면 다시 그려야 한다.
                    if (current && !editing && prevRemote !== cmd.value.remoteImages) {
                        void render(true);
                    }
                });
                break;
            }
        }
    }

    /*
     * Esc = 뒤로가기. 열려 있는 목차·찾기·다이어그램 확대를 위에서부터 하나씩 닫는다(router.ts 의 레이어 스택).
     */
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.isComposing) void pressBack();
    });

    /*
     * Tab 은 문서 화면에서 아무것도 순회하지 않는다.
     *
     * ★ 사진 뷰어에서 Tab 을 눌러도 버튼이 돌지 않는다. 여기서는 Tab 이 컨트롤 버튼과 문서 안의
     *   링크·표 영역(스크롤용 tabindex)을 차례로 돌며 초점 테두리를 그리고 컨트롤을 띄웠다.
     *   읽는 데 필요 없는 동작이다. 기능은 단축키·Alt 메뉴·우클릭으로 닿는다.
     * 자기 안에서 Tab 이 필요한 것만 남긴다: 편집기(들여쓰기는 따로 처리), 검색 바, 목차 모달, 대화상자.
     */
    window.addEventListener(
        'keydown',
        (e) => {
            if (e.key !== 'Tab') return;
            const el = e.target as Element | null;
            if (el?.closest('.desktop-editor, .search-bar, .sheet-backdrop, .dialog-backdrop'))
                return;
            e.preventDefault();
        },
        true,
    );

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
