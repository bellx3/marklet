import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 오픈소스 고지문(THIRD_PARTY_NOTICES.txt) — 설치 파일에 실려 나간다.
 * 파일은 `npm run notices` 가 만든다(scripts/make-notices.mjs). 의존성을 바꾸고 다시 만들지 않으면
 * 여기서 걸린다.
 */
const text = fs.readFileSync(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.txt'), 'utf8');
const index = text.split('목록 (Index)')[1]?.split('====')[0] ?? '';

describe('THIRD_PARTY_NOTICES.txt', () => {
    it('우리가 번들에 넣는 핵심 라이브러리가 모두 있다', () => {
        for (const name of [
            'markdown-it',
            'dompurify',
            'katex',
            'mermaid',
            'highlight.js',
            'js-yaml',
        ]) {
            expect(index, name).toMatch(new RegExp(`^\\s+${name.replace('.', '\\.')}@`, 'm'));
        }
    });

    it('★ 라이선스 전문이 실려 있다 — 이름만 나열한 목록이 아니다', () => {
        expect(text).toContain('Permission is hereby granted, free of charge');
        expect(text).toContain('Redistribution and use in source and binary forms');
    });

    it('★ 강한 카피레프트(GPL · AGPL · SSPL)가 들어오면 알린다 — 배포 조건이 달라진다', () => {
        // LGPL 은 허용 목록이 아니라 눈으로 보고 판단할 일이다. 여기서는 막지 않는다.
        const strong = index.split('\n').filter((l) => /(^|[^L])GPL|SSPL/.test(l));
        expect(strong).toEqual([]);
    });
});
