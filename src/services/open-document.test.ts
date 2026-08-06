import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t } from '../i18n';
import type { MdDocument } from '../plugins/md-file';

/*
 * 11-2절 #20 — 매니페스트 필터 (D)로 들어온 바이너리 방어.
 */

const mdFile = { read: vi.fn() };
vi.mock('../plugins/md-file', () => ({
    MdFile: { read: (o: unknown) => mdFile.read(o) },
}));

const toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
vi.mock('../utils/toast', () => ({ Toast: { ...toast } }));

const dialog = { confirmDialog: vi.fn() };
vi.mock('../utils/dialog', () => ({
    confirmDialog: (o: unknown) => dialog.confirmDialog(o),
}));

const {
    looksLikeText,
    byteSize,
    openDocument,
    gateContent,
    isGoogleDoc,
    HARD_LIMIT_BYTES,
    CONFIRM_LIMIT_BYTES,
    PROGRESS_HINT_BYTES,
} = await import('./open-document');

const DOC: MdDocument = {
    uri: 'content://x/1',
    name: 'a.md',
    size: 10,
    mimeType: 'text/markdown',
    writable: true,
};

beforeEach(() => {
    vi.clearAllMocks();
    dialog.confirmDialog.mockResolvedValue(true);
});

describe('looksLikeText', () => {
    it('★ 널 바이트가 있으면 텍스트가 아니다', () => {
        expect(looksLikeText(`앞${String.fromCharCode(0)}뒤`)).toBe(false);
    });

    it('치환문자가 5% 이상이면 텍스트가 아니다', () => {
        expect(looksLikeText('�'.repeat(50) + 'a'.repeat(50))).toBe(false);
    });

    it('치환문자가 조금 섞인 정도는 통과시킨다 (깨진 글자 하나로 문서를 막지 않는다)', () => {
        expect(looksLikeText('가'.repeat(999) + '�')).toBe(true);
    });

    it('빈 문서는 텍스트로 본다', () => {
        expect(looksLikeText('')).toBe(true);
    });

    it('평범한 한글 마크다운은 통과한다', () => {
        expect(looksLikeText('# 제목\n\n본문입니다. **굵게**\n')).toBe(true);
    });
});

describe('byteSize', () => {
    it('★ doc.size 가 0 이상이면 그 값을 우선한다', () => {
        expect(byteSize({ ...DOC, size: 12345 }, 'abc')).toBe(12345);
        expect(byteSize({ ...DOC, size: 0 }, 'abc')).toBe(0);
    });

    it('크기를 모르면(-1) 내용의 바이트 수를 센다 — 문자 수가 아니다', () => {
        // 한글 1자 = UTF-8 3바이트
        expect(byteSize({ ...DOC, size: -1 }, '가나다')).toBe(9);
        expect(byteSize({ ...DOC, size: -1 }, 'abc')).toBe(3);
    });
});

describe('openDocument — 크기 게이트', () => {
    function withContent(content: string, size = -1): void {
        mdFile.read.mockResolvedValue({ ...DOC, size, content, encoding: 'UTF-8' });
    }

    it('작은 문서는 확인 없이 바로 연다', async () => {
        withContent('짧은 문서', 100);
        const r = await openDocument(DOC);
        expect(r.kind).toBe('render');
        expect(r.kind === 'render' && r.showProgress).toBe(false);
        expect(dialog.confirmDialog).not.toHaveBeenCalled();
    });

    /*
     * ★★ read() 는 describe(uri) 만 돌려준다 — persisted 가 들어 있지 않다.
     *   그걸 이어 붙이지 않으면 pickFile()/listFolder() 가 알려 준
     *   "다시 열 수 있다" 가 사라져서, 갓 고른 파일이 '읽기 전용 사본' 으로 뜨고
     *   rememberDoc 이 필요 없는 사본을 매번 만든다(2026-08-04 에뮬레이터).
     *   다음 실행의 reconcileRecents() 가 바로잡아 주기 때문에 더 늦게 찾았다.
     */
    it('★ 부른 쪽이 알려 준 persisted 를 잃지 않는다', async () => {
        withContent('짧은 문서', 100);
        const r = await openDocument({ ...DOC, persisted: true });
        expect(r.kind === 'render' && r.doc.persisted).toBe(true);
    });

    it('read() 가 준 persisted 도 그대로 쓴다', async () => {
        mdFile.read.mockResolvedValue({ ...DOC, size: 100, content: 'x', persisted: true });
        const r = await openDocument(DOC);
        expect(r.kind === 'render' && r.doc.persisted).toBe(true);
    });

    it('512KB 를 넘으면 진행 표시를 켠다', async () => {
        withContent('x', PROGRESS_HINT_BYTES + 1);
        const r = await openDocument(DOC);
        expect(r.kind === 'render' && r.showProgress).toBe(true);
    });

    it('2MB 를 넘으면 확인을 받는다', async () => {
        withContent('x', CONFIRM_LIMIT_BYTES + 1);
        await openDocument(DOC);
        expect(dialog.confirmDialog).toHaveBeenCalledTimes(1);
    });

    it('2MB 확인에서 취소하면 열지 않는다', async () => {
        withContent('x', CONFIRM_LIMIT_BYTES + 1);
        dialog.confirmDialog.mockResolvedValue(false);
        expect((await openDocument(DOC)).kind).toBe('cancelled');
    });

    it('★ 4MB 를 넘으면 서식 없이 여는 경로만 준다', async () => {
        withContent('x', HARD_LIMIT_BYTES + 1);
        const r = await openDocument(DOC);
        expect(r.kind).toBe('plain');
        expect(dialog.confirmDialog).toHaveBeenCalledWith(
            expect.objectContaining({ confirmText: t.gate.tooBigConfirm }),
        );
    });

    it('바이너리는 오류로 막는다', async () => {
        withContent(`PNG${String.fromCharCode(0)}`, 500);
        const r = await openDocument(DOC);
        expect(r.kind).toBe('error');
        expect(r.kind === 'error' && r.message).toBe(t.gate.notText);
    });

    it('CP949 로 읽혔으면 저장 시 UTF-8 로 바뀐다고 알린다', async () => {
        mdFile.read.mockResolvedValue({ ...DOC, content: '한글', encoding: 'EUC-KR' });
        await openDocument(DOC);
        expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('UTF-8'));
    });

    it('읽기 오류 코드를 사람이 읽을 문장으로 바꾼다', async () => {
        mdFile.read.mockRejectedValue(Object.assign(new Error('x'), { code: 'EPERM' }));
        const r = await openDocument(DOC);
        // ★ 문구가 아니라 **어느 갈래가 골라졌는지**를 본다. 문구의 정직함은 i18n.test.ts 가 지킨다.
        expect(r.kind === 'error' && r.message).toBe(t.gate.noPermission);

        mdFile.read.mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOENT' }));
        expect((await openDocument(DOC)).kind === 'error').toBe(true);
    });
});

/*
 * 회귀: openFromRecent 에서 gateContent 호출을 지우면
 *   "이미 읽어 둔 내용도 같은 게이트를 지난다" 가 실패하는 것을 확인함.
 *
 * 최근 문서·사본·공유된 텍스트는 원본을 다시 읽지 않으므로 openDocument() 를 쓸 수 없다.
 * 그래서 게이트가 따로 나와 있고, 화면에 올리는 모든 경로가 이걸 지나야 한다.
 */
describe('gateContent — 읽기 없이 게이트만', () => {
    it('MdFile.read 를 부르지 않는다 (사본은 다시 읽을 원본이 없다)', async () => {
        const r = await gateContent({ ...DOC, size: 100 }, '짧은 문서');
        expect(mdFile.read).not.toHaveBeenCalled();
        expect(r.kind).toBe('render');
    });

    it('★ 바이너리를 똑같이 막는다', async () => {
        const r = await gateContent(DOC, `PNG${String.fromCharCode(0)}`);
        expect(r.kind).toBe('error');
    });

    it('★ 4MB 초과면 똑같이 텍스트 전용 경로를 준다', async () => {
        const r = await gateContent({ ...DOC, size: HARD_LIMIT_BYTES + 1 }, 'x');
        expect(r.kind).toBe('plain');
    });

    it('★ 2MB 초과면 똑같이 확인을 받는다', async () => {
        await gateContent({ ...DOC, size: CONFIRM_LIMIT_BYTES + 1 }, 'x');
        expect(dialog.confirmDialog).toHaveBeenCalledTimes(1);
    });

    it('openDocument 와 같은 판정을 내린다 (한쪽만 고치는 걸 막는다)', async () => {
        // doc 은 read() 가 채운 content 때문에 다르다. 판정(kind·content·showProgress)만 비교한다.
        const strip = (o: unknown) => {
            const rest = { ...(o as Record<string, unknown>) };
            delete rest.doc;
            return rest;
        };
        for (const size of [100, CONFIRM_LIMIT_BYTES + 1, HARD_LIMIT_BYTES + 1]) {
            mdFile.read.mockResolvedValue({ ...DOC, size, content: '짧은 문서' });
            const viaRead = await openDocument(DOC);
            const viaGate = await gateContent({ ...DOC, size }, '짧은 문서');
            expect(strip(viaGate)).toEqual(strip(viaRead));
        }
    });
});

describe('isGoogleDoc', () => {
    it('Google 문서로 변환된 파일을 알아본다', () => {
        expect(isGoogleDoc({ ...DOC, mimeType: 'application/vnd.google-apps.document' })).toBe(
            true,
        );
        expect(isGoogleDoc({ ...DOC, mimeType: 'text/markdown' })).toBe(false);
        expect(isGoogleDoc({ ...DOC, mimeType: null })).toBe(false);
    });

    /**
     * ★★★ 2026-08-06. isGoogleDoc 은 **자기 테스트에서만** 쓰이고 있었다.
     *
     *   함수도 있고 주석에 "조용히 실패하지 말고 안내한다(M04)" 라고 적혀 있고
     *   테스트까지 녹색이었는데, **앱 어디에서도 부르지 않았다.**
     *   즉 요구사항은 구현되지 않았고, 테스트는 구현된 듯한 느낌만 줌.
     *
     *   실제로는 read() 가 그냥 던지고(구글 문서는 바이트 스트림이 없다)
     *   사용자는 원인 없는 자바 예외 메시지를 보게 된다.
     */
    it('★ 읽기 전에 막고 뭔가 해야 하는지 알려 준다', async () => {
        const out = await openDocument({
            ...DOC,
            mimeType: 'application/vnd.google-apps.document',
        });
        expect(out).toEqual({ kind: 'error', message: t.gate.googleDoc });
        expect(mdFile.read, '읽지도 말아야 한다').not.toHaveBeenCalled();
    });

    it('★ 최근 문서·공유 경로(gateContent)에서도 막는다', async () => {
        const out = await gateContent(
            { ...DOC, mimeType: 'application/vnd.google-apps.spreadsheet' },
            '무슨 글이든',
        );
        expect(out).toEqual({ kind: 'error', message: t.gate.googleDoc });
    });

    it('멀줦한 파일은 그대로 열린다 (위 검사가 과하지 않다)', async () => {
        mdFile.read.mockResolvedValue({ ...DOC, content: '본문' });
        expect((await openDocument(DOC)).kind).toBe('render');
    });
});
