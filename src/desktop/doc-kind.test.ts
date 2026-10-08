import { describe, it, expect } from 'vitest';
import { isPlainTextName, normalizeNewlines } from './doc-kind';

describe('문서 종류', () => {
    it('.txt 만 서식 없이 본다', () => {
        for (const n of ['a.txt', 'A.TXT', '메모.txt']) expect(isPlainTextName(n), n).toBe(true);
        for (const n of ['a.md', 'a.markdown', 'txt', 'a.txt.md', 'a.text']) {
            expect(isPlainTextName(n), n).toBe(false);
        }
    });

    it('★ 줄바꿈 통일 — 파일(CRLF)과 편집기(LF)를 비교해도 수정됨이 되지 않는다', () => {
        expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
        expect(normalizeNewlines('a\r\nb')).toBe(normalizeNewlines('a\nb'));
    });
});
