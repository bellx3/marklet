import { describe, it, expect } from 'vitest';
import { parseDocument, renderFrontmatter } from './frontmatter';

/**
 * 11-2절 #7.
 * ★ CORE_SCHEMA 가 DEFAULT_SCHEMA 로 바뀌는 것을 막는 테스트다.
 *   DEFAULT_SCHEMA 는 !!js/function 같은 태그를 해석해 임의 코드 실행으로 이어진다.
 */

describe('parseDocument', () => {
    it('앞머리 YAML 을 분리한다', () => {
        const { frontmatter, body } = parseDocument(
            '---\ntitle: 제목\ntags: [a, b]\n---\n\n본문\n',
        );
        expect(frontmatter).toEqual({ title: '제목', tags: ['a', 'b'] });
        expect(body.trim()).toBe('본문');
    });

    it('앞머리가 없으면 본문이 그대로다', () => {
        const src = '# 제목\n\n본문\n';
        const { frontmatter, body } = parseDocument(src);
        expect(frontmatter).toBeNull();
        expect(body).toBe(src);
    });

    it('★ BOM 이 붙어 있어도 매치된다', () => {
        const { frontmatter, body } = parseDocument('﻿---\ntitle: 제목\n---\n\n본문\n');
        expect(frontmatter).toEqual({ title: '제목' });
        expect(body.trim()).toBe('본문');
    });

    it('★ !!js/function 은 차단된다 (CORE_SCHEMA)', () => {
        const src = '---\nevil: !!js/function "function(){return 1}"\n---\n\n본문\n';
        const { frontmatter, body } = parseDocument(src);
        // 파싱이 실패하면 frontmatter 는 null 이고 본문은 살아남아야 한다.
        expect(frontmatter).toBeNull();
        expect(body).toContain('본문');
    });

    it('★ 깨진 YAML 이어도 본문이 살아남는다 (화면이 비면 안 된다)', () => {
        const { frontmatter, body } = parseDocument('---\n: : :\n  - [\n---\n\n본문은 남는다\n');
        expect(frontmatter).toBeNull();
        expect(body).toContain('본문은 남는다');
    });

    it('★ 64KB 를 넘는 앞머리는 파싱하지 않는다 (CPU 고갈 방지)', () => {
        const huge = `title: ${'가'.repeat(70 * 1024)}`;
        const { frontmatter, body } = parseDocument(`---\n${huge}\n---\n\n본문\n`);
        expect(frontmatter).toBeNull();
        expect(body).toContain('본문');
    });

    it('스칼라(문자열 하나)만 있는 앞머리는 객체가 아니므로 무시한다', () => {
        const { frontmatter } = parseDocument('---\n그냥문자열\n---\n\n본문\n');
        expect(frontmatter).toBeNull();
    });
});

describe('renderFrontmatter', () => {
    it('키·값을 표로 그리고 값을 textContent 로만 넣는다 (XSS 방지)', () => {
        const el = renderFrontmatter({ title: '<img src=x onerror=alert(1)>', n: 3 });
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(el.textContent).toContain('3');
    });

    it('배열 값도 읽을 수 있게 펼친다', () => {
        const el = renderFrontmatter({ tags: ['a', 'b'] });
        expect(el.textContent).toContain('a');
        expect(el.textContent).toContain('b');
    });
});
