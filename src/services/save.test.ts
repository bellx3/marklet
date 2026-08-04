import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t } from '../i18n';
import type { MdDocument } from '../plugins/md-file';

/*
 * 11-2절 #10 · #11 · #12.
 *
 * ★ 목은 네이티브 경계에서만 만든다(11-1절 2번). 형태는 MdFilePlugin.java 의
 *   call.resolve / ret.put( 호출을 보고 맞췄다:
 *     read()  → uri, name, size, mimeType, writable, content, encoding
 *     write() → bytesWritten, uri
 *
 * 회귀: saveDocument 의 백업 try/catch 를 지우고 그냥 진행하게 만들면
 *   "백업이 실패하면 write 가 호출되지 않는다" 테스트가 실패하는 것을 확인함.
 */

const mdFile = {
    read: vi.fn(),
    write: vi.fn(),
};
const fs = {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
};

vi.mock('../plugins/md-file', () => ({
    MdFile: {
        read: (o: { uri: string }) => mdFile.read(o),
        write: (o: { uri: string; content: string }) => mdFile.write(o),
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        mkdir: (o: unknown) => fs.mkdir(o),
        writeFile: (o: unknown) => fs.writeFile(o),
        readFile: (o: unknown) => fs.readFile(o),
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

const { saveDocument, backupName, isCloudUri } = await import('./save');

const DOC: MdDocument = {
    uri: 'content://test/doc/1',
    name: 'note.md',
    size: 10,
    mimeType: 'text/markdown',
    writable: true,
};

beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
});

describe('saveDocument — 원본을 망가뜨리지 않는 순서', () => {
    it('★ 백업이 실패하면 MdFile.write 가 호출되지 않는다 (이 앱에서 가장 중요한 테스트)', async () => {
        mdFile.read.mockResolvedValue({ ...DOC, content: '원본' });
        fs.writeFile.mockRejectedValue(new Error('저장 공간 없음'));

        const r = await saveDocument(DOC, '새 내용');

        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('backup-failed');
        expect(mdFile.write).not.toHaveBeenCalled();
        // ★ "원본을 건드리지 않았다"고 말하는 그 메시지가 맞는지 본다.
        //   문구 자체(거짓말을 하지 않는가)는 i18n.test.ts 가 두 언어 모두 지킨다.
        expect(r.ok === false && r.message).toBe(t.save.backupFailed);
    });

    it('원본 읽기 자체가 실패해도 write 로 넘어가지 않는다', async () => {
        mdFile.read.mockRejectedValue(Object.assign(new Error('권한 없음'), { code: 'EPERM' }));

        const r = await saveDocument(DOC, '새 내용');

        expect(r.ok === false && r.reason).toBe('backup-failed');
        expect(mdFile.write).not.toHaveBeenCalled();
    });

    it('★ writable:false 면 즉시 readonly 로 끝나고 백업도 시도하지 않는다', async () => {
        const r = await saveDocument({ ...DOC, writable: false }, '새 내용');

        expect(r.ok === false && r.reason).toBe('readonly');
        expect(mdFile.read).not.toHaveBeenCalled();
        expect(fs.writeFile).not.toHaveBeenCalled();
        expect(mdFile.write).not.toHaveBeenCalled();
    });

    it('정상 경로: 백업 → 쓰기 → 검증 순으로 돈다', async () => {
        mdFile.read
            .mockResolvedValueOnce({ ...DOC, content: '원본' }) // 백업용
            .mockResolvedValueOnce({ ...DOC, content: '새 내용' }); // 검증용
        mdFile.write.mockResolvedValue({ bytesWritten: 9, uri: DOC.uri });

        const r = await saveDocument(DOC, '새 내용');

        expect(r).toEqual({ ok: true, bytesWritten: 9 });
        expect(fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: backupName(DOC.uri), data: '원본' }),
        );
        expect(mdFile.write).toHaveBeenCalledWith({ uri: DOC.uri, content: '새 내용' });
        expect(mdFile.read).toHaveBeenCalledTimes(2);
    });

    it('★ 되읽은 내용이 다르면 verify-failed 와 backupPath 가 함께 온다', async () => {
        mdFile.read
            .mockResolvedValueOnce({ ...DOC, content: '원본' })
            .mockResolvedValueOnce({ ...DOC, content: '엉뚱한 내용' });
        mdFile.write.mockResolvedValue({ bytesWritten: 9, uri: DOC.uri });

        const r = await saveDocument(DOC, '새 내용');

        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toBe('verify-failed');
        // 출구가 사라지면 안 된다 — 사용자가 백업을 볼 수 있어야 한다
        expect(r.ok === false && r.backupPath).toBe(backupName(DOC.uri));
    });

    it('쓰기 실패도 backupPath 를 함께 준다', async () => {
        mdFile.read.mockResolvedValue({ ...DOC, content: '원본' });
        mdFile.write.mockRejectedValue(Object.assign(new Error('x'), { code: 'EREADONLY' }));

        const r = await saveDocument(DOC, '새 내용');

        expect(r.ok === false && r.reason).toBe('write-failed');
        expect(r.ok === false && r.backupPath).toBe(backupName(DOC.uri));
        expect(r.ok === false && r.message).toBe(t.save.readOnlyLocation);
    });

    it('검증 단계에서 읽기가 터져도 backupPath 를 준다', async () => {
        mdFile.read
            .mockResolvedValueOnce({ ...DOC, content: '원본' })
            .mockRejectedValueOnce(new Error('읽기 실패'));
        mdFile.write.mockResolvedValue({ bytesWritten: 9, uri: DOC.uri });

        const r = await saveDocument(DOC, '새 내용');

        expect(r.ok === false && r.reason).toBe('verify-failed');
        expect(r.ok === false && r.backupPath).toBe(backupName(DOC.uri));
    });
});

describe('backupName', () => {
    it('같은 URI 는 같은 이름, 다른 URI 는 다른 이름', () => {
        expect(backupName('content://a')).toBe(backupName('content://a'));
        expect(backupName('content://a')).not.toBe(backupName('content://b'));
    });
    it('파일 이름에 쓸 수 없는 문자가 없다', () => {
        expect(backupName('content://x/y%20z?q=1')).toMatch(/^backup\/[a-z0-9]+\.md$/);
    });
});

describe('isCloudUri', () => {
    it('Drive·OneDrive 를 알아본다', () => {
        expect(isCloudUri('content://com.google.android.apps.docs.storage/document/1')).toBe(true);
        expect(isCloudUri('content://com.microsoft.skydrive.content/1')).toBe(true);
        expect(isCloudUri('content://com.android.externalstorage.documents/document/1')).toBe(
            false,
        );
    });
});
