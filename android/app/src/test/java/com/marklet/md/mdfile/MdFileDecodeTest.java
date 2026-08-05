package com.marklet.md.mdfile;

import static org.junit.Assert.*;

import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

/**
 * 인코딩 판정 (설계서 5-2절 · 14-1절 1번).
 *
 * ★★ 설계서가 이 코드를 두고 "컴파일도 실행도 하지 않았다" 고 적어 두었다.
 *   기기가 필요 없는 순수 함수인데 시험되지 않고 있었다 — 그래서 여기에 고정한다.
 *
 * ★ 무엇이 제일 위험한가. **오탐이다.**
 *   멀쩡한 UTF-8 한글 문서를 EUC-KR 로 잘못 읽으면 화면이 깨진 채 열리고,
 *   사용자가 그 상태로 저장하면 **원본까지 망가진다.** 되돌릴 방법이 없다.
 *   반대(CP949 를 UTF-8 로 읽음)는 화면만 깨지고 원본은 안전하다.
 *   그래서 판정은 보수적이어야 한다 — 확실할 때만 EUC-KR 로 간다.
 */
public class MdFileDecodeTest {

    private static final String KO = "# 한글 문서\n\n다람쥐 헌 쳇바퀴에 타고파.\n- 목록 하나\n";

    private static TextDecoding.Result decode(byte[] bytes) {
        return TextDecoding.decode(bytes);
    }

    // ── 정상 UTF-8 ──────────────────────────────────────────────

    @Test
    public void utf8_한글문서를_그대로_읽는다() {
        TextDecoding.Result d = decode(KO.getBytes(StandardCharsets.UTF_8));
        assertEquals("UTF-8", d.charset);
        assertEquals(KO, d.text);
    }

    @Test
    public void utf8_이모지와_한자도_깨지지_않는다() {
        String s = "이모지 🎉 한자 漢字 그리고 수식 $E=mc^2$";
        TextDecoding.Result d = decode(s.getBytes(StandardCharsets.UTF_8));
        assertEquals("UTF-8", d.charset);
        assertEquals(s, d.text);
    }

    @Test
    public void 영문만_있는_문서() {
        String s = "# Plain ASCII\n\nJust English.\n";
        TextDecoding.Result d = decode(s.getBytes(StandardCharsets.US_ASCII));
        assertEquals("UTF-8", d.charset);
        assertEquals(s, d.text);
    }

    @Test
    public void 빈_파일도_터지지_않는다() {
        TextDecoding.Result d = decode(new byte[0]);
        assertEquals("UTF-8", d.charset);
        assertEquals("", d.text);
    }

    // ── BOM ────────────────────────────────────────────────────

    @Test
    public void utf8_BOM_을_벗겨_낸다() {
        byte[] body = KO.getBytes(StandardCharsets.UTF_8);
        byte[] withBom = new byte[body.length + 3];
        withBom[0] = (byte) 0xEF;
        withBom[1] = (byte) 0xBB;
        withBom[2] = (byte) 0xBF;
        System.arraycopy(body, 0, withBom, 3, body.length);

        TextDecoding.Result d = decode(withBom);
        assertEquals("UTF-8", d.charset);
        // ★ BOM 이 남으면 첫 글자가 보이지 않는 U+FEFF 가 되어 제목 파싱이 어긋난다.
        assertFalse("BOM 이 본문에 남았다", d.text.startsWith("﻿"));
        assertTrue(d.text.startsWith("# 한글"));
    }

    @Test
    public void BOM_보다_짧은_파일() {
        TextDecoding.Result d = decode(new byte[] { (byte) 0xEF, (byte) 0xBB });
        assertNotNull(d.text);
    }

    // ── CP949 폴백 ─────────────────────────────────────────────

    @Test
    public void cp949_한글문서를_알아보고_되살린다() throws UnsupportedEncodingException {
        TextDecoding.Result d = decode(KO.getBytes("EUC-KR"));
        assertEquals("EUC-KR", d.charset);
        assertEquals(KO, d.text);
        assertFalse("치환 문자가 남았다", d.text.contains("�"));
    }

    @Test
    public void cp949_긴_문서도_되살린다() throws UnsupportedEncodingException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 300; i++) sb.append("한글 줄 ").append(i).append("\n");
        String s = sb.toString();

        TextDecoding.Result d = decode(s.getBytes("EUC-KR"));
        assertEquals("EUC-KR", d.charset);
        assertEquals(s, d.text);
    }

    // ── ★ 오탐 — 여기가 제일 중요하다 ───────────────────────────

    /**
     * 문서 **자체가** 깨진 글자를 설명하고 있는 경우.
     * 예: "인코딩이 틀리면 이렇게 보입니다: ￯﾿﾿￯﾿﾿…"
     * 이런 문서를 EUC-KR 로 되읽으면 멀쩡한 본문이 통째로 망가진다.
     */
    @Test
    public void 오탐_치환문자가_섞인_UTF8_문서를_망가뜨리지_않는다() {
        StringBuilder sb = new StringBuilder("# 깨진 글자를 설명하는 문서\n\n이렇게 보입니다: ");
        for (int i = 0; i < 200; i++) sb.append('�');
        sb.append("\n\n원래 글자는 '한글' 입니다.\n");
        String s = sb.toString();

        TextDecoding.Result d = decode(s.getBytes(StandardCharsets.UTF_8));

        // 무엇으로 판정하든, **읽을 수 있는 부분이 살아 있어야 한다.**
        assertTrue("문서 앞부분이 사라졌다: " + d.text.substring(0, Math.min(40, d.text.length())),
                d.text.contains("깨진 글자를 설명하는 문서"));
        assertTrue(d.text.contains("원래 글자는"));
    }

    /** 한글이 하나도 없는데 EUC-KR 로 가면 안 된다. */
    @Test
    public void 오탐_영문_문서는_언제나_UTF8() {
        String s = "# Release notes\n\n- Fixed a crash\n- Added dark mode\n";
        assertEquals("UTF-8", decode(s.getBytes(StandardCharsets.US_ASCII)).charset);
    }

    // ── replacementRatio ───────────────────────────────────────

    @Test
    public void 비율_계산() {
        assertEquals(0.0, TextDecoding.replacementRatio(""), 0.0001);
        assertEquals(0.0, TextDecoding.replacementRatio("정상 문서"), 0.0001);
        assertEquals(0.5, TextDecoding.replacementRatio("�A"), 0.0001);
        assertEquals(1.0, TextDecoding.replacementRatio("��"), 0.0001);
    }

    /** ★ 앞 8192자만 본다. 큰 문서에서 전체를 훑으면 느리다. */
    @Test
    public void 비율은_앞부분_표본만_본다() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8192; i++) sb.append('가');
        for (int i = 0; i < 8192; i++) sb.append('�');
        assertEquals(0.0, TextDecoding.replacementRatio(sb.toString()), 0.0001);
    }
}
