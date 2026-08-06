package com.marklet.md.mdfile;

import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 예외를 JS 가 알아보는 오류 코드로 바꾼다. **순수 함수만 있다.**
 *
 * ★★ 왜 떼어 냈는가 (2026-08-06).
 *   `read()` 안에 이렇게 적혀 있었다:
 *       if (is == null) { call.reject("파일을 열 수 없습니다", "ENOENT"); return; }
 *       ...
 *       catch (IOException | RuntimeException e) { call.reject(..., "EIO", e); }
 *
 *   그런데 **ContentResolver.openInputStream 은 없는 파일에 null 을 주지 않는다.**
 *   FileNotFoundException 을 던진다(문서화된 동작이다). 그래서 ENOENT 분기는
 *   사실상 죽은 코드였고, JS 쪽 `t.gate.notFound`
 *   ("파일을 찾을 수 없습니다. 이동되거나 삭제된 것 같습니다.") 도 영영 안 떴다.
 *
 *   사용자가 실제로 보던 것:
 *       파일을 여는 중 오류가 발생했습니다.
 *       (/document/1234: open failed: ENOENT (No such file or directory))
 *
 *   ★ 그리고 이건 **가장 흔한 실패**다. 최근 목록·폴더 목록에 남아 있는 파일을
 *     사용자가 파일 관리자에서 지우거나 옮기면 바로 이 길로 온다.
 *     원인을 아는 순간 할 일이 명확한 상황인데(다시 고르면 된다) 그걸 못 알려 줬다.
 *
 * ★ 안드로이드는 **읽을 수 없는 파일도** FileNotFoundException 으로 던진다.
 *   그때는 메시지 안에 EACCES 가 들어 있다. 없어진 것과 권한 문제는
 *   사용자가 할 일이 다르므로(다시 고르기 vs 권한 다시 받기) 갈라 준다.
 */
final class UriErrors {

    private UriErrors() {}

    /** 접근 권한 문제 */
    static final String EPERM = "EPERM";
    /** 파일이 없다 (지워졌거나 옮겨졌다) */
    static final String ENOENT = "ENOENT";
    /** 그 외 입출력 오류 */
    static final String EIO = "EIO";
    /** 쓰기를 아예 받지 않는 위치 */
    static final String EREADONLY = "EREADONLY";

    /**
     * 예외 하나를 코드로 바꾼다.
     *
     * @param e 잡은 예외
     * @return EPERM · ENOENT · EREADONLY · EIO 중 하나
     */
    static String codeOf(Throwable e) {
        if (e instanceof SecurityException) return EPERM;
        if (e instanceof UnsupportedOperationException) return EREADONLY;
        if (e instanceof FileNotFoundException) {
            return looksLikePermission(e) ? EPERM : ENOENT;
        }
        if (e instanceof IOException) {
            // 스트림을 여는 데는 성공했는데 도중에 끊긴 경우다. 권한 문구가 섞여 있으면 그쪽이다.
            return looksLikePermission(e) ? EPERM : EIO;
        }
        return EIO;
    }

    /**
     * 메시지에 권한 거부 흔적이 있는가.
     * ★ 원인 사슬(getCause)까지 본다 — 안드로이드는 ErrnoException 을 감싸서 던진다.
     */
    private static boolean looksLikePermission(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            String m = t.getMessage();
            if (m == null) continue;
            String lower = m.toLowerCase();
            if (lower.contains("eacces") || lower.contains("permission den")) return true;
            if (t.getCause() == t) break; // 자기 자신을 원인으로 가리키는 예외 방어
        }
        return false;
    }
}
