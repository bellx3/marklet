import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { MdFile, type MdDocument } from '../plugins/md-file';
import { record } from '../utils/perf';
import { t } from '../i18n';

/**
 * 원본을 망가뜨리지 않는 저장 순서 (5-6절).
 *
 * ★ 사용자의 문서는 우리가 만든 게 아니다. 여기서 실수하면 사용자가 몇 년간 써 온
 *   원본 노트가 사라지고 되돌릴 방법이 없다.
 *
 * ★ content:// 에는 원자적 rename 이 없다. 임시 파일에 쓰고 바꿔치기하는 일반적인
 *   안전 기법을 쓸 수 없다 — 프로바이더가 다른 앱 소유라 우리가 통제할 수 없다.
 *   그래서 '쓰기 전 백업'만이 유일한 방어선이다.
 *
 *   1. 쓰기 가능 여부 확인      writable === false 면 즉시 '새 이름으로 저장'으로 유도
 *   2. 원본을 읽어 앱 캐시에 백업  ← 실패하면 저장을 진행하지 않는다
 *   3. 쓰기
 *   4. 다시 읽어 검증
 *   5. 실패하면 백업 경로와 함께 화면에 띄우고 '새 이름으로 저장'을 제공한다
 */

export type SaveResult =
    | { ok: true; bytesWritten: number }
    | {
          ok: false;
          reason: 'readonly' | 'backup-failed' | 'write-failed' | 'verify-failed';
          message: string;
          backupPath?: string;
      };

/** URI를 파일 이름으로 쓸 수 있게 만든다. (djb2 변형) */
export function backupName(uri: string): string {
    let h = 5381;
    for (let i = 0; i < uri.length; i++) h = ((h * 33) ^ uri.charCodeAt(i)) >>> 0;
    return `backup/${h.toString(36)}.md`;
}

export async function saveDocument(doc: MdDocument, content: string): Promise<SaveResult> {
    const t0 = performance.now();
    const done = <T extends SaveResult>(r: T): T => {
        record('save:total', performance.now() - t0);
        return r;
    };

    // ── 1. 쓰기 가능 여부
    if (!doc.writable) {
        return done({
            ok: false,
            reason: 'readonly',
            message: t.save.readOnly,
        });
    }

    const path = backupName(doc.uri);

    // ── 2. 백업 (앱 전용 저장소이므로 @capacitor/filesystem 으로 충분하다)
    try {
        const original = await MdFile.read({ uri: doc.uri });
        await Filesystem.mkdir({
            path: 'backup',
            directory: Directory.Data,
            recursive: true,
        }).catch(() => {
            /* 이미 있으면 통과 */
        });
        await Filesystem.writeFile({
            path,
            directory: Directory.Data,
            data: original.content ?? '',
            encoding: Encoding.UTF8,
        });
    } catch {
        // ★ 백업 실패 = 저장 중단. 여기서 멈추는 게 원본을 지키는 길이다.
        return done({
            ok: false,
            reason: 'backup-failed',
            /*
             * ★ "파일은 그대로 남아 있습니다" 라고 쓰지 마라. 백업이 실패하는 이유는 둘인데
             *   ① 저장 공간 부족 — 이때는 원본이 그대로다
             *   ② 원본을 못 읽음(삭제·이동·권한 만료) — 이때는 **원본이 이미 없다**
             *   ②에서 "그대로 남아 있다"는 거짓말이 된다(2026-08-03 에뮬레이터에서 확인).
             *   두 경우 모두 참인 문장은 "우리가 건드리지 않았다" 뿐이다.
             */
            message: t.save.backupFailed,
        });
    }

    // ── 3. 쓰기
    let bytesWritten = 0;
    try {
        const res = await MdFile.write({ uri: doc.uri, content });
        bytesWritten = res.bytesWritten;
    } catch (e) {
        return done({
            ok: false,
            reason: 'write-failed',
            backupPath: path,
            message: describeWriteError(e),
        });
    }

    // ── 4. 검증: 정말 그 내용이 들어갔는지 되읽어 본다.
    //     Drive 처럼 비동기 동기화를 하는 프로바이더에서 쓰기가 조용히 무시되는 경우를 잡는다.
    try {
        const back = await MdFile.read({ uri: doc.uri });
        if ((back.content ?? '') !== content) {
            return done({
                ok: false,
                reason: 'verify-failed',
                backupPath: path,
                message: t.save.mismatch,
            });
        }
    } catch {
        return done({
            ok: false,
            reason: 'verify-failed',
            backupPath: path,
            message: t.save.verifyFailed,
        });
    }

    /*
     * ── 5. 백업을 지운다.
     *
     * ★★ 여기까지 왔다는 것은 **되읽어 검증까지 통과했다**는 뜻이다. 원본에 새 내용이
     *   확실히 들어갔으므로 옛 내용을 들고 있을 이유가 없다.
     *
     *   예전에는 지우지 않았다. 그래서 **저장에 성공할 때마다 옛 내용 전체가 한 벌씩
     *   앱 저장소에 영구히 쌓였다.** 문서당 하나라 무한 증식은 아니지만, 편집하는 문서가
     *   늘수록 그대로 늘고 지우는 경로가 아예 없었다(2026-08-06 발견).
     *
     * ★ 실패 갈래에서는 절대 지우지 마라. 거기서는 이 파일이 사용자의 유일한 밧줄이다
     *   — [백업 내용 보기] 가 이걸 읽는다.
     * ★ 지우기 실패는 삼킨다. 저장은 이미 성공했다 — 여기서 실패를 알리면
     *   "저장됐는데 실패했다" 는 앞뒤 안 맞는 말이 된다.
     */
    await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {});

    return done({ ok: true, bytesWritten });
}

function describeWriteError(e: unknown): string {
    switch ((e as { code?: string })?.code) {
        case 'EPERM':
            return t.save.noPermission;
        case 'EREADONLY':
            return t.save.readOnlyLocation;
        /*
         * ★ 지워진 파일을 EIO 로 묶지 마라. 그 문구는 "저장 공간을 확인해 주세요" 인데
         *   저장 공간과 아무 상관이 없다 — 사용자를 엉뚱한 데로 보낸다.
         *   (실제로는 2단계 백업이 먼저 막아 주지만, 네이티브가 이 코드를 내므로 받아 둔다.)
         */
        case 'ENOENT':
            return t.save.gone;
        case 'EIO':
            return t.save.ioError;
        default:
            return t.save.failed((e as Error)?.message ?? t.save.unknownError);
    }
}

/** 백업 내용을 읽어 온다. 저장 실패 다이얼로그의 [백업 내용 보기] 가 쓴다. */
export async function readBackup(backupPath: string): Promise<string | null> {
    try {
        const f = await Filesystem.readFile({
            path: backupPath,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
        });
        return f.data as string;
    } catch {
        return null;
    }
}

/** 클라우드 문서인지. Drive 계열은 다른 기기와 충돌할 수 있어 한 번 안내한다. */
export function isCloudUri(uri: string): boolean {
    return uri.includes('com.google.android.apps.docs') || uri.includes('com.microsoft.skydrive');
}
