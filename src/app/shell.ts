import { App } from '@capacitor/app';
import { MdFile, type MdDocument } from '../plugins/md-file';
import type { EntryHandlers } from '../services/document-entry';
import { openDocument as readAndGate, gateContent } from '../services/open-document';
import { rememberDoc, refreshRemembered, openRecent, type RecentDoc } from '../services/recents';
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
        const superseded = beginOpen();
        // ★ 공유된 텍스트도 같은 게이트를 지난다. 메모 앱이 아주 긴 글을 보낼 수 있다.
        const outcome = await gateContent(doc, text);
        if (superseded()) return; // 그 사이 다른 문서가 들어왔다(beginOpen 주석)
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

/**
 * 문서 열기 순번.
 *
 * ★★★ 열기 경로에는 await 가 여럿 있고 그중 둘은 **사람이 버튼을 누를 때까지** 걸린다 —
 *   크기 확인 상자('긴 문서입니다')와 초안 복구 상자('저장하지 않은 편집이 있습니다').
 *   그 사이에 다른 문서가 들어오면 **먼저 시작한 쪽이 나중에 도착해 화면을 덮는다.**
 *
 *   예: 2MB 문서를 열어 확인 상자가 떠 있는데 카톡에서 다른 .md 를 누른다
 *       → 새 문서가 열린다 → 그제서야 앞 상자에서 [열기] 를 누른다
 *       → **방금 연 문서가 앞 문서로 바뀐다.**
 *   읽기 속도만으로도 뒤집힌다. 큰 파일 A 를 먼저 누르고 작은 파일 B 를 이어 누르면
 *   B 가 먼저 뜬 뒤 A 가 덮는다.
 *
 *   viewer-screen 의 renderSeq 는 render() **안**만 지킨다. 어느 문서가 render() 를
 *   마지막에 부르느냐는 여기서 정해야 한다.
 */
let openSeq = 0;

/** 열기 시작을 알리고 '이미 밀려났는가' 를 묻는 함수를 돌려준다. */
function beginOpen(): () => boolean {
    const seq = ++openSeq;
    return () => seq !== openSeq;
}

async function openDocumentFlow(
    doc: MdDocument,
    source: RecentDoc['source'],
    from: 'external' | 'in-app',
): Promise<void> {
    const superseded = beginOpen();

    // ★ 여기서 doc:read 를 재지 마라. readAndGate 안에는 확인 다이얼로그가 들어 있어서
    //   '사용자가 버튼을 누를 때까지'가 I/O 시간으로 잡힌다(실기기에서 10.8초로 찍혔다).
    //   실제 읽기 시간은 open-document.ts 가 MdFile.read() 전후로만 잰다.
    const outcome = await readAndGate(doc);
    // ★ 읽기·확인 상자를 지나는 사이에 다른 문서가 들어왔으면 여기서 접는다(beginOpen 주석).
    if (superseded()) return;

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
            const draft = await resolveDraft(outcome.doc, outcome.content);
            // ★ 초안 복구 상자도 사람이 누를 때까지 기다린다. 다시 본다.
            if (superseded()) return;
            viewerFrom = from;
            await viewer.show(outcome.doc, draft.content, { showProgress: outcome.showProgress });
            enterViewer();
            // ★ 사본은 원본을 비춘다. 저장하지 않은 초안을 사본에 적으면 안 된다.
            void rememberDoc(outcome.doc, outcome.content, source);
            // ★ 뷰어를 먼저 세운 뒤에 연다 — openEditor 가 viewer.getContent() 를 읽는다.
            if (draft.resume) await openEditor();
            return;
        }
    }
}

/**
 * 저장하지 않은 초안이 있으면 물어본다 (8-4절).
 * ★ '버리기'를 기본 선택으로 두지 마라. 실수로 누르면 되돌릴 수 없다.
 *
 * ★★ resume 을 함께 돌려준다. 단추 이름이 '이어서 편집' 인데 뷰어에 내려놓으면
 *   **누른 것과 다른 일이 일어난다.** 앱이 죽어 편집하던 글을 잃었을까 봐 불안한
 *   바로 그 순간에, 읽기 전용 화면에 떨어뜨리고 편집 단추를 다시 찾게 만들면 안 된다.
 *   (2026-08-06 실기기에서 강제 종료 후 복구를 밟아 보고 발견)
 */
interface DraftChoice {
    content: string;
    /** 사용자가 '이어서 편집'을 골랐다 — 뷰어를 지나 편집기까지 열어 준다. */
    resume: boolean;
}

async function resolveDraft(doc: MdDocument, original: string): Promise<DraftChoice> {
    if (!doc.uri) return { content: original, resume: false };
    const draft = await readDraft(doc.uri);
    if (draft === null || draft === original) {
        if (draft !== null) await clearDraft(doc.uri);
        return { content: original, resume: false };
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

    if (answer === 'draft') return { content: draft, resume: true };
    if (answer === 'original') await clearDraft(doc.uri);
    return { content: original, resume: false };
}

async function openFromRecent(r: RecentDoc): Promise<void> {
    const superseded = beginOpen();
    const opened = await openRecent(r);
    if (superseded()) return; // 그 사이 밖에서 문서가 들어왔다(beginOpen 주석)
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

    const draft: DraftChoice =
        outcome.kind === 'plain'
            ? { content: outcome.content, resume: false }
            : await resolveDraft(opened.doc, outcome.content);
    // ★ 크기 확인 상자와 초안 복구 상자를 지나는 사이에 밖에서 문서가 들어왔을 수 있다.
    if (superseded()) return;

    viewerFrom = 'in-app';
    await viewer.show(opened.doc, draft.content, {
        plain: outcome.kind === 'plain',
        fromSnapshot: opened.fromSnapshot,
        showProgress: outcome.kind === 'render' && outcome.showProgress,
    });
    enterViewer();
    if (!opened.fromSnapshot) void rememberDoc(opened.doc, opened.content, r.source);
    if (draft.resume) await openEditor();
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

/**
 * 편집을 접는다. 초안은 지키고 나간다(destroy 안에서 flushDraft 한다).
 *
 * ★★ 편집 중에 **밖에서** 다른 문서가 들어올 수 있다 — 카톡에서 .md 를 누르는 순간이다.
 *   document-entry 는 "버리시겠습니까"만 묻고, 사용자가 승낙하면 곧바로 새 문서를 연다.
 *   그런데 그 경로는 editor 를 건드리지 않으므로 **편집기가 살아남는다.**
 *   화면은 멀쩡해 보이는데 안에서는:
 *     1) editor 가 null 이 아니고 textarea 에 옛 글이 남아 hasUnsavedChanges() 가
 *        영영 true 다 → 그 뒤로 문서를 열 때마다 근거 없는 "저장하지 않은 편집" 이 뜬다
 *     2) back 스택에 'editor' 가 남아 뒤로가기가 옛 문서의 편집 화면으로 되돌아간다
 */
function leaveEditor(): void {
    if (!editor) return;
    editor.destroy();
    editor = null;
    removeLayer('editor');
}

function enterViewer(): void {
    // ★ 문서가 화면에 올라오는 길목은 여기 하나다. 접는 것도 여기서 한다 —
    //   호출하는 쪽마다 넣으면 반드시 한 곳을 빠뜨린다.
    leaveEditor();
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
        /*
         * ★★ 사본과 크기를 새 글로 맞춘다. 안 하면 사본이 옛 글로 남아,
         *   나중에 원본을 못 열게 됐을 때 저장까지 마친 글이 조용히 되돌아간다
         *   (refreshRemembered 주석). 목록의 크기 표시도 옛 값으로 굳는다.
         */
        void refreshRemembered(doc, content);
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
         * ★ 옛 URI 의 초안을 지운다. 글은 새 파일로 옮겨 갔으니 남아 있으면 안 된다 —
         *   나중에 그 파일을 열 때 있지도 않은 "저장하지 않은 편집" 을 묻게 된다.
         *   ★★ 편집기를 접기 **전에** 지운다. clearDraft 가 대기 중인 쓰기를 취소하므로,
         *     아래 destroy() 의 flushDraft 가 방금 지운 초안을 되살리지 않는다.
         */
        if (previous?.uri) await clearDraft(previous.uri);

        Toast.success(t.shell.savedAsNew(created.name));
        // ★ createFile 이 돌려준 size 는 '방금 만든 빈 파일'의 0 이다. 그대로 저장하면
        //   최근 문서 목록에 0 B 로 뜬다(2026-08-03 확인). 실제로 쓴 크기를 넣는다.
        const written = new TextEncoder().encode(content).length;
        void rememberDoc({ ...created, size: written }, content, 'picker');

        /*
         * ★★★ 저장했으면 **편집을 끝내고 뷰어로 돌아간다** (2026-08-07).
         *
         *   saveFlow 에는 이 처리가 있는데 여기에는 없었다. 그래서 새 이름으로 저장하면
         *   화면은 편집기에 남고 뷰어만 뒤에서 조용히 바뀌었다 — 사용자는 토스트를 보고도
         *   뒤로가기를 한 번 더 눌러야 했다. 2026-08-04 에 지적받아 saveFlow 를 고쳤는데,
         *   같은 불편이 이쪽에 그대로 남아 있었다.
         *
         *   ★★ 하필 **읽기 전용 문서는 언제나 이 길로 온다.** 카톡·파일 관리자에서 들어온
         *     문서는 쓰기 권한을 못 받으므로 [저장] → 실패 → [새 이름으로 저장] 이
         *     정상 경로다. 즉 고쳤다던 불편이 가장 흔한 경로에서는 살아 있었다.
         */
        await flushDraft();
        editor?.destroy();
        editor = null;
        removeLayer('editor');
        showScreen('viewer');
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
        /*
         * ★★★ **없는 단추를 쓰라고 하면 안 된다** (2026-08-07).
         *   이 안내는 "[파일로 공유] 를 쓰시면 크기 제한 없이 보낼 수 있습니다" 라고
         *   말하는데, 그 메뉴 항목은 URI 가 없거나(공유받은 글·예제 문서) 사본으로 열린
         *   문서에서는 **숨어 있다.** 긴 글을 카톡에서 마크릿으로 보낸 뒤 다시 보내려 할 때
         *   바로 밟는 길이다. 사용자는 없는 단추를 찾아 헤매고, 자기가 못 찾는 줄 안다.
         *
         *   ★ 뷰어가 메뉴를 숨길 때 쓰는 값을 그대로 본다. 규칙을 여기서 다시 쓰면
         *     한쪽만 고쳐질 때 또 어긋난다.
         */
        const kb = Math.round(SHARE_TEXT_LIMIT / 1024);
        const size = (bytes / 1024).toFixed(0);
        await alertDialog(
            t.shell.tooBigTextTitle,
            viewer.canShareFile()
                ? t.shell.tooBigTextBody(kb, size)
                : t.shell.tooBigTextBodyNoFile(kb, size),
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

    /*
     * ★★ 진행 표시를 켜고 한다. 여기서 문서를 **청크 없이 통째로** 다시 그리므로
     *   1MB 에 데스크톱 2초, 폰이면 6~10초다(2026-08-06 실측: 렌더 519 + 살균 855 +
     *   글자 573ms). 확인 상자를 닫자마자 화면이 그만큼 굳는데 아무 표시가 없으면
     *   사용자는 앱이 멎은 줄 알고 강제 종료한다.
     * ★ withBusy 가 두 프레임을 기다린 뒤 시작한다 — 안 그러면 표시가 그려지지도 못한다.
     */
    const plain = await viewer.withBusy(t.viewer.preparingText, () => {
        const { body: markdown } = parseDocument(viewer.getContent());
        const md = createMarkdownIt({ breaks: getSettings().breaks });
        const html = sanitize(liftTaskCheckedState(md.render(markdown)));
        return htmlToPlainText(html, { title: doc.name });
    });
    await shareText(doc.name, plain);
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
