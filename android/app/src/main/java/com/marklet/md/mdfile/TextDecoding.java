package com.marklet.md.mdfile;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * 바이트를 글자로 바꾼다. **순수 함수만 있다.**
 *
 * ★★ 왜 플러그인에서 떼어 냈는가 (2026-08-05).
 *   원래 이 로직은 `MdFilePlugin` 안의 private static 이었다. 그런데 그 클래스는
 *   `extends Plugin` 이라, 순수 함수 하나를 부르려 해도 Capacitor·안드로이드 런타임이
 *   통째로 필요했다 — 결국 **아무도 시험할 수 없는 코드**가 되어 있었고,
 *   설계서 14-1절이 "컴파일도 실행도 하지 않았다"고 적어 둔 그 상태로 남아 있었다.
 *
 *   여기에는 java.nio 밖에 없으므로 기기 없이 JVM 테스트로 돈다(MdFileDecodeTest).
 *
 * ★ 무엇이 제일 위험한가 — **오탐이다.**
 *   멀쩡한 UTF-8 한글 문서를 EUC-KR 로 잘못 읽으면 화면이 깨진 채 열리고,
 *   사용자가 그대로 저장하면 원본까지 망가진다. 되돌릴 방법이 없다.
 *   반대(CP949 를 UTF-8 로 읽음)는 화면만 깨지고 원본은 안전하다.
 *   그래서 판정은 한쪽으로 기울어 있어야 한다 — **확실할 때만** EUC-KR 로 간다.
 */
final class TextDecoding {

    private TextDecoding() {}

    /** UTF-8 로 읽었을 때 이 비율을 넘게 깨지면 EUC-KR 을 의심한다. */
    private static final double SUSPECT_RATIO = 0.01;

    /** 비율을 볼 표본 길이. 전체를 훑으면 큰 파일에서 느리다. */
    private static final int SAMPLE = 8192;

    static final class Result {
        final String text;
        /** "UTF-8" 또는 "EUC-KR". JS 가 안내 문구를 띄우는 데 쓴다. */
        final String charset;

        Result(String text, String charset) {
            this.text = text;
            this.charset = charset;
        }
    }

    /**
     * UTF-8 을 먼저 시도하고, 치환 문자(U+FFFD)가 과하면 EUC-KR(CP949)로 다시 디코드한다.
     *
     * 한국어 사용자의 오래된 .md/.txt 는 CP949 인 경우가 실제로 있다. UTF-8 로만 읽으면
     * 화면이 통째로 깨져 보이고 사용자는 "앱이 고장났다"고 판단한다.
     */
    static Result decode(byte[] bytes) {
        int off = bomLength(bytes);
        String utf8 = new String(bytes, off, bytes.length - off, StandardCharsets.UTF_8);

        double utf8Ratio = replacementRatio(utf8);
        if (utf8Ratio < SUSPECT_RATIO) {
            return new Result(utf8, "UTF-8");
        }

        try {
            Charset cp949 = Charset.forName("EUC-KR");
            String alt = new String(bytes, off, bytes.length - off, cp949);
            /*
             * ★ '더 낫다'가 아니라 '거의 완벽하다'를 요구한다.
             *   EUC-KR 은 아무 바이트 쌍이나 한자·한글로 매핑해 버리므로 치환 문자가
             *   거의 안 나온다 — 그래서 단순히 `alt < utf8` 로 비교하면
             *   **치환 문자를 본문에 담은 멀쩡한 UTF-8 문서**까지 EUC-KR 로 끌려간다.
             *   그 문서는 통째로 알아볼 수 없게 된다(2026-08-05 테스트로 확인).
             */
            if (replacementRatio(alt) < SUSPECT_RATIO && utf8Ratio >= SUSPECT_RATIO) {
                return new Result(alt, "EUC-KR");
            }
        } catch (Exception ignored) {
            // EUC-KR 을 못 여는 런타임이면 UTF-8 결과를 그대로 쓴다.
        }
        return new Result(utf8, "UTF-8");
    }

    /** UTF-8 BOM 길이. 윈도우에서 만든 .md 에 흔하다. 남기면 첫 글자가 보이지 않는 U+FEFF 가 된다. */
    private static int bomLength(byte[] bytes) {
        if (bytes.length >= 3
                && (bytes[0] & 0xFF) == 0xEF
                && (bytes[1] & 0xFF) == 0xBB
                && (bytes[2] & 0xFF) == 0xBF) {
            return 3;
        }
        return 0;
    }

    /** 앞부분 표본에서 U+FFFD 비율. */
    static double replacementRatio(String s) {
        int limit = Math.min(s.length(), SAMPLE);
        if (limit == 0) return 0;
        int bad = 0;
        for (int i = 0; i < limit; i++) {
            if (s.charAt(i) == '�') bad++;
        }
        return (double) bad / limit;
    }
}
