import { MdFile, type MdDocument } from '../plugins/md-file';
import { Toast } from '../utils/toast';
import { t } from '../i18n';
import { confirmDialog } from '../utils/dialog';
import { mark, measure } from '../utils/perf';

/** 렌더 가능한 상한. 근거는 05_조사_렌더링스택.md 4.2/4.4절 (Chromium 2^25 px 클램프). */
export const HARD_LIMIT_BYTES = 4 * 1024 * 1024;
/** 여기부터 확인 다이얼로그를 띄운다. */
export const CONFIRM_LIMIT_BYTES = 2 * 1024 * 1024;
/** 여기부터 하단 진행 표시를 띄운다. */
export const PROGRESS_HINT_BYTES = 512 * 1024;

export type OpenOutcome =
    | { kind: 'render'; doc: MdDocument; content: string; showProgress: boolean }
    | { kind: 'plain'; doc: MdDocument; content: string } // 마크다운 파싱 없이 원문만
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string };

/**
 * 널 바이트가 있거나 치환문자가 과하면 텍스트가 아니라고 본다.
 * 매니페스트 필터 (D) 때문에 zip·이미지가 들어올 수 있다.
 */
export function looksLikeText(content: string): boolean {
    if (content.length === 0) return true;
    const sample = content.slice(0, 4096);
    // 널 바이트는 바이너리라는 확실한 신호다.
    if (sample.indexOf(String.fromCharCode(0)) !== -1) return false;

    let bad = 0;
    for (const ch of sample) if (ch === '�') bad++;
    return bad / sample.length < 0.05;
}

/**
 * 바이트 크기를 구한다.
 * ★ 문자 수가 아니라 바이트로 판정한다 — 4MB 상한이 바이트 기준으로 측정된 값이기 때문이다.
 *   한글 문서는 같은 바이트에서 문자 수가 1/3이라 이 기준은 보수적으로(=안전하게) 동작한다.
 */
export function byteSize(doc: MdDocument, content: string): number {
    if (doc.size >= 0) return doc.size;
    return new TextEncoder().encode(content).length;
}

export async function openDocument(doc: MdDocument): Promise<OpenOutcome> {
    let full: MdDocument;
    try {
        // ★ 계측은 이 호출만 감싼다. 게이트(확인 다이얼로그)까지 감싸면
        //   사용자가 버튼을 누를 때까지의 시간이 I/O 로 잡힌다(12-3절).
        mark('doc:read');
        full = await MdFile.read({ uri: doc.uri });
        measure('doc:read', 'doc:read');
    } catch (e) {
        return { kind: 'error', message: describeReadError(e) };
    }

    /*
     * ★★ read() 는 describe(uri) 만 돌려준다 — **persisted 가 들어 있지 않다.**
     *   여기서 doc 의 값을 이어 붙이지 않으면 pickFile()/listFolder() 가 알려 준
     *   "이 URI 는 다시 열 수 있다" 가 통째로 사라진다. 결과는 두 가지다:
     *     ① 갓 고른 파일이 최근 목록에 '읽기 전용 사본' 으로 표시된다 (거짓말)
     *     ② rememberDoc 이 필요 없는 사본을 앱 저장소에 매번 만든다 (낭비)
     *   2026-08-04 에뮬레이터에서 실제로 그랬다. 다음 실행의 reconcileRecents() 가
     *   바로잡아 주기 때문에 '가끔 그런' 것처럼 보여서 더 늦게 찾았다.
     */
    full = { ...full, persisted: doc.persisted ?? full.persisted };
    return gateContent(full, full.content ?? '');
}

/**
 * 이미 읽어 둔 내용에 게이트만 적용한다.
 *
 * ★★ 문서를 화면에 올리는 **모든 경로**가 이걸 통과해야 한다.
 *   최근 문서(사본 포함)는 원본을 다시 읽지 않고 열기 때문에 openDocument() 를 못 쓴다.
 *   그래서 게이트를 따로 뺐다 — 이게 없으면 "같은 파일인데 최근 문서에서 열면
 *   바이너리 검사도, 4MB 안내도 없이 그냥 그려지는" 상태가 된다
 *   (2026-08-03 에뮬레이터에서 실제로 그랬다).
 */
export async function gateContent(full: MdDocument, content: string): Promise<OpenOutcome> {
    if (!looksLikeText(content)) {
        return {
            kind: 'error',
            message: t.gate.notText,
        };
    }

    if (full.encoding === 'EUC-KR') {
        // 저장하면 UTF-8로 바뀐다는 걸 미리 알려야 한다. 조용히 바꾸면 사고다.
        Toast.info(t.gate.cp949);
    }

    const bytes = byteSize(full, content);
    const mb = (bytes / 1024 / 1024).toFixed(1);

    if (bytes > HARD_LIMIT_BYTES) {
        const go = await confirmDialog({
            title: t.gate.tooBigTitle,
            body: t.gate.tooBigBody(mb),
            confirmText: t.gate.tooBigConfirm,
            cancelText: t.common.cancel,
        });
        return go ? { kind: 'plain', doc: full, content } : { kind: 'cancelled' };
    }

    if (bytes > CONFIRM_LIMIT_BYTES) {
        const go = await confirmDialog({
            title: t.gate.longTitle,
            body: t.gate.longBody(mb),
            confirmText: t.common.open,
            cancelText: t.common.cancel,
        });
        if (!go) return { kind: 'cancelled' };
    }

    return {
        kind: 'render',
        doc: full,
        content,
        showProgress: bytes > PROGRESS_HINT_BYTES,
    };
}

/**
 * ★ Google Drive 는 .md 를 Google 문서로 변환해 두는 경우가 있다(2026-08-03 실측).
 *   그건 더 이상 텍스트 파일이 아니라 우리가 열 수 없다. 조용히 실패하지 말고 안내한다(M04).
 */
export function isGoogleDoc(doc: MdDocument): boolean {
    return (doc.mimeType ?? '').startsWith('application/vnd.google-apps');
}

function describeReadError(e: unknown): string {
    const code = (e as { code?: string })?.code;
    switch (code) {
        case 'EPERM':
            return t.gate.noPermission;
        case 'ENOENT':
            return t.gate.notFound;
        case 'ETOOBIG':
            return t.gate.tooBig;
        default:
            return t.gate.openError((e as Error)?.message ?? t.gate.unknown);
    }
}
