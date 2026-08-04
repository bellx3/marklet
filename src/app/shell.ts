import { App } from '@capacitor/app';
import { MdFile, type MdDocument } from '../plugins/md-file';
import type { EntryHandlers } from '../services/document-entry';
import { openDocument as readAndGate, gateContent } from '../services/open-document';
import { rememberDoc, openRecent, type RecentDoc } from '../services/recents';
import { addFolder } from '../services/folders';
import { readDraft, draftSavedAt, clearDraft, flushDraft } from '../services/draft';
import { saveDocument, readBackup, isCloudUri } from '../services/save';
import { pushLayer, removeLayer } from './router';
import { createHome, formatWhen, type HomeScreen } from './screens/home';
import { createViewerScreen, type ViewerScreen } from './screens/viewer-screen';
import { createSettings, type SettingsScreen } from './screens/settings';
import { createTipScreen, type TipScreen } from './screens/tip';
import { createDiagnostics, type DiagnosticsScreen } from './screens/diagnostics';
import { createEditor, createTextArea, type EditorHandle } from './screens/editor';
import { getSettings, updateSettings } from '../services/settings';
import { createMarkdownIt } from '../markdown/renderer';
import { sanitize } from '../markdown/sanitize';
import { liftTaskCheckedState } from '../markdown/post-process';
import { parseDocument } from '../markdown/frontmatter';
import { htmlToPlainText } from '../markdown/to-plain-text';
import { Toast } from '../utils/toast';
import { alertDialog, confirmDialog, choiceDialog } from '../utils/dialog';
import { iconButton } from './icons';
import { t, getLang } from '../i18n';

import welcomeKo from '../assets/welcome.ko.md?raw';
import welcomeEn from '../assets/welcome.en.md?raw';

/**
 * 앱 셸 — 화면들을 만들어 붙이고 그 사이를 오가는 곳.
 *
 * ★ 화면 전환은 전부 여기서만 한다. 각 화면은 자기 뒤에 무엇이 있는지 모른다.
 *   특히 뷰어의 뒤로가기는 진입 출처(external / in-app)에 따라 갈리는데(9-1절),
 *   그 판단을 화면 안에 넣으면 반드시 한 곳에서 빠뜨린다.
 */

type ScreenName = 'home' | 'viewer' | 'editor' | 'settings' | 'tip' | 'diagnostics';

let rootEl: HTMLElement;
let home: HomeScreen;
let viewer: ViewerScreen;
let settings: SettingsScreen;
let tip: TipScreen;
let diagnostics: DiagnosticsScreen;

/** 편집 화면은 문서를 열 때마다 새로 만든다(초안 URI 가 다르다). */
let editorRoot: HTMLElement;
let editorTa: HTMLTextAreaElement;
let editorTitle: HTMLElement;
let editorHint: HTMLElement;
let editor: EditorHandle | null = null;

let current: ScreenName = 'home';
/** 설정을 어디서 열었는지 — 돌아갈 곳 */
let settingsReturn: ScreenName = 'home';
/** 뷰어 진입 출처. 외부 인텐트면 뒤로가기가 '앱 종료'다. */
let viewerFrom: 'external' | 'in-app' = 'in-app';
/** 문서마다 한 번만 안내한다 (5-6절 클라우드 경고) */
const cloudWarned = new Set<string>();

const screens = new Map<ScreenName, HTMLElement>();

export function mount(root: HTMLElement): void {
    rootEl = root;
    rootEl.replaceChildren();

    home = createHome({
        openRecent: (r) => openFromRecent(r),
        openFolderFile: (d) => openDocumentFlow(d, 'folder', 'in-app'),
        pickFile: () => pickAndOpen(),
        addFolder: () => addFolderFlow(),
        openExample: () => openExample(),
        openSettings: () => openSettings(),
    });

    viewer = createViewerScreen({
        onBack: () => void backFromViewer(),
        onEdit: () => void openEditor(),
        onSettings: () => openSettings(),
        onPickFile: () => void pickAndOpen(),
        onShare: () => void shareCurrent(),
        onSharePlain: () => void sharePlainCurrent(),
        onShareFile: () => void shareFileCurrent(),
    });

    settings = createSettings({
        onBack: () => closeSettings(),
        openTip: () => openTip(),
        openDiagnostics: () => openDiagnostics(),
        onBreaksChanged: () => void viewer.rerender(),
        onImagePolicyChanged: () => void viewer.rerender(),
    });

    tip = createTipScreen(() => closeTip());
    diagnostics = createDiagnostics(() => closeDiagnostics());

    buildEditorScreen();

    register('home', home.root);
    register('viewer', viewer.root);
    register('editor', editorRoot);
    register('settings', settings.root);
    register('tip', tip.root);
    register('diagnostics', diagnostics.root);

    showScreen('home');
}

function register(name: ScreenName, el: HTMLElement): void {
    el.hidden = true;
    screens.set(name, el);
    rootEl.appendChild(el);
}

function showScreen(name: ScreenName): void {
    for (const [key, el] of screens) el.hidden = key !== name;
    current = name;
}

// ────────────────────────────────────────────────────────────
// 문서 진입 (document-entry.ts 가 부른다)
// ────────────────────────────────────────────────────────────

export const entryHandlers: EntryHandlers = {
    openDocument: (doc) => openDocumentFlow(doc, 'intent', 'external'),
    openSharedText: async (text) => {
        // 파일이 아니라 텍스트만 온 경우. 저장 대상이 없으므로 읽기 전용이다.
        const doc: MdDocument = {
            uri: '',
            name: t.shell.sharedText,
            size: new TextEncoder().encode(text).length,
            mimeType: 'text/plain',
            writable: false,
        };
        // ★ 공유된 텍스트도 같은 게이트를 지난다. 메모 앱이 아주 긴 글을 보낼 수 있다.
        const outcome = await gateContent(doc, text);
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'error') {
            await alertDialog(t.shell.cannotOpen, outcome.message);
            return;
        }
        viewerFrom = 'external';
        await viewer.show(doc, outcome.content, {
            plain: outcome.kind === 'plain',
            showProgress: outcome.kind === 'render' && outcome.showProgress,
        });
        enterViewer();
    },
    showHome: () => {
        showScreen('home');
        void home.refresh();
    },
    hasUnsavedChanges: () => editor?.isDirty() ?? false,
    confirmDiscard: () =>
        confirmDialog({
            title: t.shell.unsavedTitle,
            body: t.shell.unsavedOpenBody,
            confirmText: t.shell.openNew,
            cancelText: t.shell.keepEditing,
            destructive: true,
        }),
};

export async function refreshRecents(): Promise<void> {
    await home.refresh();
}

// ────────────────────────────────────────────────────────────
// 문서 열기
// ────────────────────────────────────────────────────────────

async function openDocumentFlow(
    doc: MdDocument,
    source: RecentDoc['source'],
    from: 'external' | 'in-app',
): Promise<void> {
    // ★ 여기서 doc:read 를 재지 마라. readAndGate 안에는 확인 다이얼로그가 들어 있어서
    //   '사용자가 버튼을 누를 때까지'가 I/O 시간으로 잡힌다(실기기에서 10.8초로 찍혔다).
    //   실제 읽기 시간은 open-document.ts 가 MdFile.read() 전후로만 잰다.
    const outcome = await readAndGate(doc);

    switch (outcome.kind) {
        case 'error':
            await alertDialog(t.shell.cannotOpen, outcome.message);
            if (current !== 'viewer') showScreen('home');
            return;
        case 'cancelled':
            if (current !== 'viewer') showScreen('home');
            return;
        case 'plain':
            viewerFrom = from;
            await viewer.show(outcome.doc, outcome.content, { plain: true });
            enterViewer();
            void rememberDoc(outcome.doc, outcome.content, source);
            return;
        case 'render': {
            const content = await resolveDraft(outcome.doc, outcome.content);
            viewerFrom = from;
            await viewer.show(outcome.doc, content, { showProgress: outcome.showProgress });
            enterViewer();
            void rememberDoc(outcome.doc, outcome.content, source);
            return;
        }
    }
}

/**
 * 저장하지 않은 초안이 있으면 물어본다 (8-4절).
 * ★ '버리기'를 기본 선택으로 두지 마라. 실수로 누르면 되돌릴 수 없다.
 */
async function resolveDraft(doc: MdDocument, original: string): Promise<string> {
    if (!doc.uri) return original;
    const draft = await readDraft(doc.uri);
    if (draft === null || draft === original) {
        if (draft !== null) await clearDraft(doc.uri);
        return original;
    }

    const at = await draftSavedAt(doc.uri);
    const when = at ? formatWhen(at) : '';
    const answer = await choiceDialog({
        title: t.shell.unsavedTitle,
        body: t.shell.draftBody(when),
        actions: [
            { label: t.shell.openOriginal, value: 'original' },
            { label: t.shell.resumeEditing, value: 'draft', primary: true },
        ],
    });

    if (answer === 'draft') return draft;
    if (answer === 'original') await clearDraft(doc.uri);
    return original;
}

async function openFromRecent(r: RecentDoc): Promise<void> {
    const opened = await openRecent(r);
    if (!opened) {
        await alertDialog(t.shell.cannotOpen, t.shell.noOriginal);
        return;
    }
    /*
     * ★★ 최근 문서도 반드시 같은 게이트를 통과시킨다.
     *   openRecent 는 사본 폴백이 있어서 openDocument(=읽기+게이트)를 쓸 수 없다.
     *   그래서 이미 읽은 내용에 게이트만 다시 건다. 이걸 빼면 같은 파일인데
     *   "폴더에서 열면 안내가 뜨고 최근 문서에서 열면 안 뜨는" 상태가 된다.
     */
    const outcome = await gateContent(opened.doc, opened.content);
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'error') {
        await alertDialog(t.shell.cannotOpen, outcome.message);
        return;
    }

    viewerFrom = 'in-app';
    const content =
        outcome.kind === 'plain'
            ? outcome.content
            : await resolveDraft(opened.doc, outcome.content);
    await viewer.show(opened.doc, content, {
        plain: outcome.kind === 'plain',
        fromSnapshot: opened.fromSnapshot,
        showProgress: outcome.kind === 'render' && outcome.showProgress,
    });
    enterViewer();
    if (!opened.fromSnapshot) void rememberDoc(opened.doc, opened.content, r.source);
}

async function pickAndOpen(): Promise<void> {
    try {
        const doc = await MdFile.pickFile();
        if (doc.cancelled) return;
        await openDocumentFlow(doc, 'picker', 'in-app');
    } catch (err) {
        console.error('파일 선택 실패:', err);
        Toast.error(t.shell.pickFailed((err as Error)?.message ?? t.gate.unknown));
    }
}

async function addFolderFlow(): Promise<void> {
    try {
        const folder = await addFolder();
        if (!folder) return;
        Toast.success(t.shell.folderAdded(folder.name));
        await home.refresh();
    } catch (err) {
        await alertDialog(t.shell.folderAddFailed, (err as Error).message);
    }
}

async function openExample(): Promise<void> {
    // ★ 기기 언어가 아니라 **앱 언어**를 따른다. 설정에서 영어로 바꿔 놓고
    //   예제만 한국어로 열리면 앞뒤가 맞지 않는다.
    const ko = getLang() === 'ko';
    const doc: MdDocument = {
        uri: '',
        name: t.shell.guideTitle,
        size: -1,
        mimeType: 'text/markdown',
        writable: false,
    };
    viewerFrom = 'in-app'; // ★ 예제 문서는 in-app 이다(9-3절)
    await viewer.show(doc, ko ? welcomeKo : welcomeEn);
    enterViewer();
}

// ────────────────────────────────────────────────────────────
// 화면 전환
// ────────────────────────────────────────────────────────────

function enterViewer(): void {
    showScreen('viewer');
    // ★ 여는 순간 동기적으로 등록한다(9-3절).
    pushLayer('viewer', () => {
        void backFromViewer();
        return true;
    });
}

async function backFromViewer(): Promise<void> {
    viewer.closeOverlays();
    if (viewerFrom === 'external') {
        // ★ 카카오톡에서 문서를 보고 뒤로 갔는데 우리 시작 화면이 뜨면
        //   사용자는 카톡으로 돌아갈 수 없다고 느낀다.
        removeLayer('viewer');
        await App.exitApp().catch(() => {
            // 웹 환경에는 없다. 그때는 홈으로.
            showScreen('home');
        });
        return;
    }
    removeLayer('viewer');
    showScreen('home');
    await home.refresh();
}

function openSettings(): void {
    settingsReturn = current === 'settings' ? settingsReturn : current;
    settings.refresh();
    showScreen('settings');
    pushLayer('settings', () => {
        closeSettings();
        return true;
    });
}

function closeSettings(): void {
    removeLayer('settings');
    showScreen(settingsReturn);
    if (settingsReturn === 'home') void home.refresh();
}

function openTip(): void {
    tip.refresh();
    showScreen('tip');
    pushLayer('tip', () => {
        closeTip();
        return true;
    });
}

function closeTip(): void {
    removeLayer('tip');
    settings.refresh(); // 후원자 배지가 방금 켜졌을 수 있다
    showScreen('settings');
}

function openDiagnostics(): void {
    diagnostics.refresh();
    showScreen('diagnostics');
    pushLayer('diagnostics', () => {
        closeDiagnostics();
        return true;
    });
}

function closeDiagnostics(): void {
    removeLayer('diagnostics');
    showScreen('settings');
}

// ────────────────────────────────────────────────────────────
// 편집 (S3)
// ────────────────────────────────────────────────────────────

function buildEditorScreen(): void {
    editorRoot = document.createElement('div');
    editorRoot.className = 'screen screen-editor';

    const bar = document.createElement('div');
    bar.className = 'app-topbar';

    const back = iconButton('back', t.editor.exitEdit, () => void closeEditor());

    editorTitle = document.createElement('h1');
    editorTitle.className = 'topbar-title topbar-title--doc';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-compact';
    save.textContent = t.editor.save;
    save.addEventListener('click', () => void saveFlow());

    bar.append(back, editorTitle, save);

    /*
     * ★ '한 줄 개행 유지'가 꺼져 있으면 여기서 친 엔터 한 번이 뷰어에서 줄바꿈으로 안 보인다.
     *   마크다운 규칙상 맞는 동작이지만, **방금 자기 손으로 엔터를 친 사람**에게는
     *   "앱이 내 줄바꿈을 먹었다"로 읽힌다(2026-08-04 사장님 보고).
     *   설정 화면까지 찾아가게 하지 말고 여기서 바로 켤 수 있게 한다.
     */
    editorHint = document.createElement('div');
    editorHint.className = 'editor-hint';
    editorHint.hidden = true;

    const hintText = document.createElement('span');
    hintText.textContent = t.editor.breaksHint;

    const hintBtn = document.createElement('button');
    hintBtn.type = 'button';
    hintBtn.className = 'editor-hint-btn';
    hintBtn.textContent = t.editor.breaksHintButton;
    hintBtn.addEventListener('click', () => {
        void updateSettings({ breaks: true }).then(() => {
            editorHint.hidden = true;
            void viewer.rerender();
        });
    });

    editorHint.append(hintText, hintBtn);

    editorTa = createTextArea();
    editorRoot.append(bar, editorHint, editorTa);
}

async function openEditor(): Promise<void> {
    const doc = viewer.getDoc();
    if (!doc) return;

    if (!doc.uri) {
        await alertDialog(t.shell.cannotEditTitle, t.shell.cannotEditBody);
        return;
    }

    // 클라우드 문서는 문서당 한 번 안내한다(5-6절).
    if (isCloudUri(doc.uri) && !cloudWarned.has(doc.uri)) {
        cloudWarned.add(doc.uri);
        await alertDialog(t.shell.cloudTitle, t.shell.cloudBody);
    }

    // ★ 뷰어를 떠나기 전에 열려 있는 것들을 닫는다. 특히 검색 <mark> 를 남기면
    //   편집 → 저장 → 다시 그리기 사이에 어긋난 하이라이트가 남는다.
    viewer.closeOverlays();

    editorTitle.textContent = doc.name;
    // 설정을 바꿨을 수 있으니 열 때마다 다시 본다.
    editorHint.hidden = getSettings().breaks;
    editor?.destroy();
    editor = createEditor(editorTa, doc.uri, viewer.getContent());

    showScreen('editor');
    pushLayer('editor', async () => {
        await closeEditor();
        return true; // 닫든 안 닫든 '내가 처리했다'
    });
    editorTa.focus();
}

async function closeEditor(): Promise<void> {
    if (editor?.isDirty()) {
        const ok = await confirmDialog({
            title: t.shell.exitEditTitle,
            body: t.shell.exitEditBody,
            confirmText: t.editor.exitEdit,
            cancelText: t.shell.keepEditing,
            destructive: true,
        });
        if (!ok) return;
    }
    await flushDraft();
    editor?.destroy();
    editor = null;
    removeLayer('editor');
    showScreen('viewer');
}

async function saveFlow(): Promise<void> {
    const doc = viewer.getDoc();
    if (!doc || !editor) return;

    const content = editor.getValue();
    const result = await saveDocument(doc, content);

    if (result.ok) {
        editor.markSaved();
        viewer.setContent(content);
        await clearDraft(doc.uri);
        Toast.success(t.shell.saved);

        /*
         * ★ 저장하면 편집을 끝내고 뷰어로 돌아간다.
         *   저장은 "이 편집을 마쳤다"는 뜻이다. 저장 뒤에도 편집 화면에 남겨 두면
         *   사용자가 토스트를 보고도 뒤로가기를 한 번 더 눌러야 한다(2026-08-04 사장님 지적).
         *   ★ closeEditor() 를 부르지 말 것 — markSaved() 직후라 isDirty() 는 false 지만,
         *     그 함수는 확인 다이얼로그 분기를 거치므로 의도가 흐려진다. 여기서 바로 닫는다.
         */
        await flushDraft();
        editor.destroy();
        editor = null;
        removeLayer('editor');
        showScreen('viewer');
        await viewer.rerender();
        return;
    }

    // ★ 저장 실패를 토스트로 끝내지 마라. 반드시 출구를 함께 줘라(5-6절).
    const actions = [{ label: t.common.close, value: 'close' }];
    if (result.backupPath) actions.push({ label: t.shell.viewBackup, value: 'backup' });
    actions.push({ label: t.shell.saveAsNew, value: 'saveas' });

    const answer = await choiceDialog({
        title: t.shell.saveFailedTitle,
        body: result.message,
        actions: actions.map((a, i) => ({ ...a, primary: i === actions.length - 1 })),
    });

    if (answer === 'saveas') await saveAsFlow(content);
    else if (answer === 'backup' && result.backupPath) await showBackup(result.backupPath);
}

async function saveAsFlow(content: string): Promise<void> {
    const previous = viewer.getDoc();
    const base = previous?.name ?? 'document.md';
    try {
        const created = await MdFile.createFile({ name: suggestName(base) });
        if (created.cancelled) return;

        const result = await saveDocument(created, content);
        if (!result.ok) {
            await alertDialog(t.shell.saveAsFailedTitle, result.message);
            return;
        }

        // ── 이제부터 이 파일이 원본이다.
        viewer.setContent(content);
        await viewer.show(created, content);

        /*
         * ★★ 편집기를 새 URI 로 다시 묶는다.
         *   createEditor 는 만들 때 받은 uri 로 초안을 저장한다. 여기서 다시 묶지 않으면
         *   이어서 친 글자가 **이미 없어진 옛 파일의 초안**으로 쌓이고,
         *   저장 성공 시 clearDraft 는 새 URI 만 지워서 옛 초안이 영영 남는다.
         *   (2026-08-03 에뮬레이터에서 '새 이름으로 저장' 뒤에 확인한 것)
         */
        if (editor) {
            editor.destroy();
            editor = createEditor(editorTa, created.uri, content);
            editorTitle.textContent = created.name;
        }
        if (previous?.uri) await clearDraft(previous.uri);

        Toast.success(t.shell.savedAsNew(created.name));
        // ★ createFile 이 돌려준 size 는 '방금 만든 빈 파일'의 0 이다. 그대로 저장하면
        //   최근 문서 목록에 0 B 로 뜬다(2026-08-03 확인). 실제로 쓴 크기를 넣는다.
        const written = new TextEncoder().encode(content).length;
        void rememberDoc({ ...created, size: written }, content, 'picker');
    } catch (err) {
        await alertDialog(
            t.shell.createFailedTitle,
            (err as Error)?.message ?? t.common.unknownError,
        );
    }
}

/** 'note.md' → 'note (사본).md' / 'note (copy).md' */
export function suggestName(name: string): string {
    const suffix = ` (${t.shell.copySuffix})`;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}${suffix}.md`;
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}

async function showBackup(backupPath: string): Promise<void> {
    const text = await readBackup(backupPath);
    if (text === null) {
        await alertDialog(t.shell.backupReadFailedTitle, t.shell.backupNotFound);
        return;
    }
    const doc: MdDocument = {
        uri: '',
        name: t.shell.backupTitle,
        size: new TextEncoder().encode(text).length,
        mimeType: 'text/markdown',
        writable: false,
    };
    removeLayer('editor');
    editor?.destroy();
    editor = null;
    viewerFrom = 'in-app';
    await viewer.show(doc, text, { fromSnapshot: true });
    showScreen('viewer');
}

// ────────────────────────────────────────────────────────────
// 공유 — v1 은 텍스트만 (5-8절)
// ────────────────────────────────────────────────────────────

/**
 * 인텐트 extra 는 Binder 트랜잭션 한도(대략 1MB)에 걸린다. 넉넉히 아래로 자른다.
 *
 * ★★ 이 상한을 빼면 큰 문서를 공유할 때 **받는 앱이 죽는다.**
 *   2026-08-04 실기기: 카카오톡이 채팅방 목록을 띄우다가 통째로 사라졌다.
 *   우리 앱은 아무 오류도 못 받는다 — 터지는 쪽은 상대 앱이기 때문이다.
 *   그래서 보내기 전에 우리가 막아야 한다.
 */
const SHARE_TEXT_LIMIT = 100 * 1024;

/** 원문이 그대로 간다는 안내를 한 번만 띄운다(5-8절). */
let shareNoticeShown = false;

/**
 * 문서 파일 자체를 공유한다 (5-8절).
 *
 * ★★ MIME 은 `application/octet-stream` 이다. `text/markdown` 이 아니다.
 *   2026-08-04 실기기 실측:
 *     - `text/markdown` + FileProvider  → **카카오톡이 받지 않는다**
 *     - `application/octet-stream` + FileProvider → **카카오톡에 올라간다**
 *   `text/markdown` 은 `text/*` 라서 메신저가 '텍스트 메시지'로 다루려다 실패한다.
 *   파일 이름의 `.md` 는 그대로 가므로 받는 쪽이 마크다운으로 알아보는 데 지장이 없다
 *   (PC 카카오톡에서 보낸 `.md` 도 같은 방식으로 도착하고 내장 뷰어가 붙는다 — 실측).
 *
 * ★ 사용자에게 MIME 을 고르게 하지 마라. 잠깐 그런 선택지를 뒀었는데
 *   '파일 형식 강제' 같은 말은 일반 사용자에게 아무 뜻도 아니다. 되는 쪽을 그냥 쓴다.
 */
const SHARE_FILE_MIME = 'application/octet-stream';

async function shareFileCurrent(): Promise<void> {
    const doc = viewer.getDoc();
    if (!doc?.uri) {
        await alertDialog(t.shell.cannotShareFileTitle, t.shell.cannotShareFileBody);
        return;
    }

    try {
        await MdFile.shareFile({
            uri: doc.uri,
            name: doc.name,
            mimeType: SHARE_FILE_MIME,
            dialogTitle: t.shell.shareDialogTitle,
        });
    } catch (err) {
        await alertDialog(
            t.shell.shareFileFailedTitle,
            (err as Error)?.message ?? t.common.unknownError,
        );
    }
}

/** 두 가지 글자 공유가 함께 쓰는 상한·전송. 상한을 넘으면 보내지 않는다. */
async function shareText(name: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > SHARE_TEXT_LIMIT) {
        await alertDialog(
            t.shell.tooBigTextTitle,
            t.shell.tooBigTextBody(Math.round(SHARE_TEXT_LIMIT / 1024), (bytes / 1024).toFixed(0)),
        );
        return;
    }
    try {
        const { Share } = await import('@capacitor/share');
        await Share.share({ title: name, text, dialogTitle: t.shell.shareDialogTitle });
    } catch (err) {
        // 사용자가 취소하면 여기로 온다. 오류로 떠들지 않는다.
        console.warn('공유 취소 또는 실패:', err);
    }
}

/** '보이는 대로' 안내를 한 번만 띄운다. */
let plainNoticeShown = false;

/**
 * 화면에 보이는 대로 — 기호를 걷어낸 읽기 좋은 글자로 공유한다 (5-8절).
 *
 * ★ 화면의 DOM 을 쓰지 않고 여기서 한 번 더 그린다. 화면 쪽은 청크가 덜 붙어 있을 수 있고,
 *   공유하려고 renderRest() 를 부르면 큰 문서에서 화면이 멈춘다(6-3절).
 */
async function sharePlainCurrent(): Promise<void> {
    const doc = viewer.getDoc();
    if (!doc) return;

    if (!plainNoticeShown) {
        const go = await confirmDialog({
            title: t.shell.plainNoticeTitle,
            body: t.shell.plainNoticeBody,
            confirmText: t.common.share,
            cancelText: t.common.cancel,
        });
        if (!go) return;
        plainNoticeShown = true;
    }

    const { body: markdown } = parseDocument(viewer.getContent());
    const md = createMarkdownIt({ breaks: getSettings().breaks });
    const html = sanitize(liftTaskCheckedState(md.render(markdown)));
    await shareText(doc.name, htmlToPlainText(html, { title: doc.name }));
}

async function shareCurrent(): Promise<void> {
    const doc = viewer.getDoc();
    if (!doc) return;

    /*
     * ★ 받는 사람은 렌더된 화면이 아니라 **마크다운 원문**을 본다(5-8절).
     *   그걸 모르고 보내면 "왜 이렇게 지저분하게 갔지?"가 되고 그게 곧 ★1 이다.
     *   한 번만 알린다 — 매번 물으면 방해가 된다.
     */
    if (!shareNoticeShown) {
        const go = await confirmDialog({
            title: t.shell.sourceNoticeTitle,
            body: t.shell.sourceNoticeBody,
            confirmText: t.shell.shareAsIs,
            cancelText: t.common.cancel,
        });
        if (!go) return;
        shareNoticeShown = true;
    }

    await shareText(doc.name, viewer.getContent());
}
