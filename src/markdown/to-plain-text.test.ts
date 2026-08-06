import { describe, it, expect } from 'vitest';
import { t } from '../i18n';
import { createMarkdownIt } from './renderer';
import { sanitize } from './sanitize';
import { liftTaskCheckedState } from './post-process';
import { htmlToPlainText } from './to-plain-text';

/**
 * 공유 3형태 중 '보이는 대로'(5-8절).
 *
 * ★ 실제 렌더 결과에 적용한다. 손으로 쓴 HTML 로 테스트하면
 *   markdown-it 출력이 바뀌어도 통과해 버린다(11-1절 1번).
 */
function plain(markdown: string, title?: string): string {
    const md = createMarkdownIt({ breaks: true });
    return htmlToPlainText(sanitize(liftTaskCheckedState(md.render(markdown))), { title });
}

describe('htmlToPlainText — 기호를 걷어낸다', () => {
    it('제목의 # 이 사라진다', () => {
        const t = plain('# 큰 제목\n\n## 작은 제목\n');
        expect(t).toContain('큰 제목');
        expect(t).toContain('작은 제목');
        expect(t).not.toContain('#');
    });

    it('굵게·기울임 기호가 사라지고 글자는 남는다', () => {
        const t = plain('이건 **굵게** 이고 *기울임* 입니다.\n');
        expect(t).toBe('이건 굵게 이고 기울임 입니다.');
    });

    it('인라인 코드의 백틱이 사라진다', () => {
        expect(plain('`코드` 입니다.\n')).toBe('코드 입니다.');
    });

    it('★ 표는 구분선(|---|)만 버리고 열 구분은 남긴다', () => {
        const t = plain('| 항목 | 값 |\n|---|---|\n| 이름 | Marklet |\n');
        expect(t).toContain('항목 | 값');
        expect(t).toContain('이름 | Marklet');
        expect(t).not.toContain('---');
    });

    it('목록이 • 로 바뀌고 중첩은 들여쓰기된다', () => {
        const t = plain('- 하나\n- 둘\n  - 둘의 하나\n');
        expect(t).toContain('• 하나');
        expect(t).toContain('  • 둘의 하나');
    });

    it('번호 목록은 번호를 유지한다', () => {
        const t = plain('1. 첫째\n2. 둘째\n');
        expect(t).toContain('1. 첫째');
        expect(t).toContain('2. 둘째');
    });

    it('★ 체크박스 상태가 보인다 (렌더 단계에서만 알 수 있는 정보다)', () => {
        const t = plain('- [x] 완료\n- [ ] 미완료\n');
        expect(t).toContain('☑ 완료');
        expect(t).toContain('☐ 미완료');
    });

    it('★ 코드 블록은 손대지 않는다 — 기호가 곧 내용이다', () => {
        const t = plain('```js\nconst x = { a: 1 };\n```\n');
        expect(t).toContain('const x = { a: 1 };');
    });

    it('링크는 글자와 주소를 함께 남긴다', () => {
        expect(plain('[여기](https://example.com) 를 보세요\n')).toContain(
            '여기 (https://example.com)',
        );
    });

    it('주소가 곧 글자면 두 번 적지 않는다', () => {
        const t = plain('<https://example.com>\n');
        expect(t).toBe('https://example.com');
    });

    it('인용은 들여쓰기로 바뀐다 (> 를 되살리지 않는다)', () => {
        // ★ 인용만 있는 문서로 시험하지 마라. 문서 전체에 trim() 이 걸려서
        //   맨 앞 들여쓰기가 잘리고, 그건 이 함수의 잘못이 아니다.
        const t = plain('앞 문단\n\n> 인용문입니다\n\n뒤 문단\n');
        expect(t).toContain('  인용문입니다');
        expect(t).not.toContain('>');
    });

    it('가로줄이 읽을 수 있는 선으로 바뀐다', () => {
        expect(plain('---\n')).toContain('────');
    });

    it('★ 다이어그램은 조용히 사라지지 않고 자리를 남긴다', () => {
        const md = createMarkdownIt({ breaks: true });
        const host = document.createElement('div');
        host.innerHTML = sanitize(md.render('```mermaid\nflowchart LR\n A --> B\n```\n'));
        // post-process 가 붙이는 래퍼를 흉내 낸다 (실제 앱에서는 markMermaidBlocks 가 한다)
        const pre = host.querySelector('pre')!;
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-block';
        pre.replaceWith(wrap);
        wrap.appendChild(pre);
        expect(htmlToPlainText(host.innerHTML)).toContain(t.plain.diagram);
    });

    it('이미지는 alt 와 함께 자리를 남긴다', () => {
        expect(plain('![고양이](https://x/cat.png)\n')).toContain(t.plain.image('고양이'));
    });

    it('제목을 맨 앞에 붙일 수 있다', () => {
        expect(plain('본문\n', 'note.md').startsWith('note.md')).toBe(true);
    });

    it('빈 줄이 세 줄 넘게 이어지지 않는다', () => {
        expect(plain('# 가\n\n\n\n나\n')).not.toMatch(/\n{3}/);
    });

    it('실제 문서 한 판 — 기호가 남지 않는다', () => {
        const t = plain(
            [
                '# 회의록',
                '',
                '## 안건',
                '',
                '- [x] **첫째** 항목',
                '- [ ] 둘째',
                '',
                '| 이름 | 값 |',
                '|---|---|',
                '| a | 1 |',
                '',
                '> 인용',
                '',
                '본문에 `코드` 와 [링크](https://e.com) 가 있습니다.',
            ].join('\n'),
        );
        expect(t).not.toMatch(/^#/m);
        expect(t).not.toContain('**');
        expect(t).not.toContain('|---');
        expect(t).not.toContain('`');
        expect(t).toContain('☑ 첫째 항목');
        expect(t).toContain('이름 | 값');
    });
});

/**
 * ★★★ 2026-08-06. 목록 **안의** 코드 블록에서 들여쓰기가 통째로 뭉개졌다.
 *
 *   목록 항목은 inline() 으로 옮기는데, inline() 은 이어진 공백을 한 칸으로 줄인다.
 *   문단에서는 맞는 처리지만 코드 안에서는 **들여쓰기가 곧 문법**이다.
 *   파이썬은 실행이 안 되는 글이 되고 JSON·YAML 은 구조가 사라진다.
 *
 *   그리고 이건 남에게 **보내는** 글이다. 받는 사람은 원본이 그런 줄 안다.
 *   AI 가 쓴 설치 안내는 거의 항상 "1. …" 아래에 코드 블록을 놓는다 —
 *   가장 흔한 모양이 가장 크게 깨져 있었다.
 */
describe('★★ 목록 안의 블록 — 들여쓰기가 곧 뜻이다', () => {
    const 파이썬 = [
        '1. 함수를 만듭니다',
        '',
        '   ```python',
        '   def f(x):',
        '       if x > 0:',
        '           return x',
        '       return 0',
        '   ```',
        '',
        '2. 끝',
    ].join('\n');

    /**
     * ★ '안쪽이 더 들여써져 있다'로만 보면 **약하다.** 4칸이 1칸으로 줄어도
     *   0 < 1 이라 통과해 버린다(처음에 그렇게 썼다가 역방향 확인에서 들켰다).
     *   들여쓰기의 **양**을 그대로 잰다.
     */
    function 들여쓰기(out: string, 줄: RegExp): number {
        const m = out.match(줄);
        if (!m) throw new Error(`그 줄이 없다: ${줄}\n---\n${out}`);
        return m[1].length;
    }

    it('★ 파이썬 들여쓰기가 4칸 그대로 살아남는다', () => {
        const out = plain(파이썬);
        const def = 들여쓰기(out, /^(\s*)def f\(x\):$/m);
        expect(들여쓰기(out, /^(\s*)if x > 0:$/m) - def, 'if 는 def 보다 4칸 안쪽').toBe(4);
        expect(들여쓰기(out, /^(\s*)return x$/m) - def, 'return x 는 8칸 안쪽').toBe(8);
        expect(들여쓰기(out, /^(\s*)return 0$/m) - def, 'return 0 은 4칸 안쪽').toBe(4);
    });

    it('★ JSON 들여쓰기가 2칸 그대로 살아남는다', () => {
        const out = plain(
            ['1. 설정', '', '   ```json', '   {', '     "port": 3000', '   }', '   ```'].join('\n'),
        );
        const brace = 들여쓰기(out, /^(\s*)\{$/m);
        expect(들여쓰기(out, /^(\s*)"port": 3000$/m) - brace).toBe(2);
        expect(들여쓰기(out, /^(\s*)\}$/m) - brace).toBe(0);
    });

    it('코드가 항목 글자와 한 줄로 붙지 않는다', () => {
        const out = plain(파이썬);
        expect(out).not.toMatch(/함수를 만듭니다.*def/);
    });

    it('번호는 계속 이어진다 (블록을 떼어 내도 흐트러지지 않는다)', () => {
        const out = plain(파이썬);
        expect(out).toContain('1. 함수를 만듭니다');
        expect(out).toContain('2. 끝');
    });

    it('항목 안의 인용·표도 한 줄로 뭉치지 않는다', () => {
        const out = plain(
            [
                '- 항목',
                '',
                '  > 주의하세요',
                '',
                '  | 열A | 열B |',
                '  |---|---|',
                '  | 1 | 2 |',
            ].join('\n'),
        );
        expect(out).toMatch(/^\s*주의하세요$/m);
        expect(out).toMatch(/^\s*열A \| 열B$/m);
        expect(out).toMatch(/^\s*1 \| 2$/m);
    });

    it('중첩 목록은 예전처럼 들여쓰기로 남는다 (회귀)', () => {
        const out = plain(['1. 겉', '', '   - 안', '     - 더 안'].join('\n'));
        const 안 = out.match(/^(\s*)• 안$/m)![1].length;
        const 더안 = out.match(/^(\s*)• 더 안$/m)![1].length;
        expect(안).toBeGreaterThan(0);
        expect(더안).toBeGreaterThan(안);
    });
});
