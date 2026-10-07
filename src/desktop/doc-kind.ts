/** .txt 는 마크다운이 아니다. 서식 없이 글자 그대로 보여 준다. */
export function isPlainTextName(name: string): boolean {
    return /\.txt$/i.test(name);
}

/**
 * 줄바꿈을 LF 로 통일한다.
 *
 * ★ textarea 의 value 는 CRLF 를 LF 로 바꿔 돌려준다. 파일에서 읽은 글(CRLF)과 편집기의 글(LF)을
 *   그대로 비교하면 **한 글자도 안 고쳤는데 '수정됨'** 이 된다. 둘 다 이 함수를 거쳐 비교한다.
 *   파일에 쓸 때의 줄바꿈은 메인이 열 때 본 방식으로 되돌린다(desktop/text.cjs applyEol).
 */
export function normalizeNewlines(s: string): string {
    return s.replace(/\r\n?/g, '\n');
}
