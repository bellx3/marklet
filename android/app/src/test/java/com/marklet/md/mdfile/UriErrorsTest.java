package com.marklet.md.mdfile;

import static org.junit.Assert.*;

import java.io.FileNotFoundException;
import java.io.IOException;

import org.junit.Test;

/**
 * 예외 → 오류 코드 분류 (5-2절 · 14-1절).
 *
 * ★★★ 2026-08-06. 이 분류가 `read()` 안에 박혀 있어서 **기기 없이는 한 줄도
 *   시험할 수 없었다.** 그 상태로 이런 코드가 있었다:
 *
 *       if (is == null) { call.reject("파일을 열 수 없습니다", "ENOENT"); return; }
 *       ...
 *       catch (IOException | RuntimeException e) { call.reject(..., "EIO", e); }
 *
 *   그런데 ContentResolver.openInputStream 은 **없는 파일에 null 을 주지 않는다.**
 *   FileNotFoundException 을 던진다. 그래서 ENOENT 분기는 죽은 코드였고,
 *   JS 의 "파일을 찾을 수 없습니다. 이동되거나 삭제된 것 같습니다." 도 영영 안 떴다.
 *
 *   사용자가 실제로 보던 것:
 *       파일을 여는 중 오류가 발생했습니다.
 *       (/document/1234: open failed: ENOENT (No such file or directory))
 *
 *   ★ 그리고 이건 **가장 흔한 실패**다. 최근 목록에 남은 파일을 파일 관리자에서
 *     지우거나 옮기면 바로 이 길로 온다. 원인을 알면 할 일이 명확한데(다시 고르기)
 *     그걸 못 알려 줬다.
 */
public class UriErrorsTest {

    // ── 없어진 파일 ─────────────────────────────────────────────

    @Test
    public void 없는_파일은_ENOENT() {
        // 안드로이드가 실제로 던지는 메시지 모양이다.
        FileNotFoundException e =
                new FileNotFoundException("/document/1234: open failed: ENOENT (No such file or directory)");
        assertEquals(UriErrors.ENOENT, UriErrors.codeOf(e));
    }

    @Test
    public void 메시지가_없어도_ENOENT() {
        assertEquals(UriErrors.ENOENT, UriErrors.codeOf(new FileNotFoundException()));
    }

    // ── 권한 ────────────────────────────────────────────────────

    @Test
    public void SecurityException_은_EPERM() {
        assertEquals(UriErrors.EPERM, UriErrors.codeOf(new SecurityException("Permission Denial")));
    }

    /**
     * ★ 안드로이드는 **읽을 수 없는 파일도** FileNotFoundException 으로 던진다.
     *   없어진 것과 권한 문제는 사용자가 할 일이 다르다 —
     *   다시 고르기 vs 권한 다시 받기. 메시지로 갈라야 한다.
     */
    @Test
    public void 권한_거부는_FileNotFound_로_와도_EPERM() {
        FileNotFoundException e =
                new FileNotFoundException("/document/1234: open failed: EACCES (Permission denied)");
        assertEquals(UriErrors.EPERM, UriErrors.codeOf(e));
    }

    @Test
    public void 대소문자를_가리지_않는다() {
        assertEquals(
                UriErrors.EPERM,
                UriErrors.codeOf(new FileNotFoundException("open failed: eacces")));
        assertEquals(
                UriErrors.EPERM,
                UriErrors.codeOf(new FileNotFoundException("Permission Denied for uri")));
    }

    @Test
    public void 원인_사슬_안의_권한도_찾는다() {
        // 안드로이드는 ErrnoException 을 감싸서 던진다.
        IOException wrapped = new IOException("write failed", new IOException("EACCES (Permission denied)"));
        assertEquals(UriErrors.EPERM, UriErrors.codeOf(wrapped));
    }

    // ── 그 외 ───────────────────────────────────────────────────

    @Test
    public void 쓰기를_받지_않는_위치는_EREADONLY() {
        assertEquals(
                UriErrors.EREADONLY,
                UriErrors.codeOf(new UnsupportedOperationException("read-only provider")));
    }

    @Test
    public void 평범한_입출력_오류는_EIO() {
        assertEquals(UriErrors.EIO, UriErrors.codeOf(new IOException("No space left on device")));
    }

    @Test
    public void 알_수_없는_예외도_EIO_로_떨어진다() {
        assertEquals(UriErrors.EIO, UriErrors.codeOf(new IllegalStateException("뭔가 잘못됨")));
        assertEquals(UriErrors.EIO, UriErrors.codeOf(new RuntimeException()));
    }

    /** ★ 자기 자신을 원인으로 가리키는 예외에서 무한 반복하지 않는다. */
    @Test
    public void 원인이_자기자신이어도_멈춘다() {
        class Loop extends IOException {
            Loop() {
                super("loop");
            }

            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        }
        assertEquals(UriErrors.EIO, UriErrors.codeOf(new Loop()));
    }
}
