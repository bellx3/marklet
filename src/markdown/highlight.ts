import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';

/**
 * core + 언어 12개 = gzip 22.8KB(실측).
 * lib/common(37개)은 52.4KB, 전체(190개+)는 307.1KB. Shiki 는 1,641KB 로 논외.
 */
const LANGUAGES = {
    javascript,
    typescript,
    python,
    java,
    kotlin,
    bash,
    json,
    yaml,
    xml,
    sql,
    css,
    markdown,
};

for (const [name, lang] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, lang);
}

hljs.registerAliases(['js'], { languageName: 'javascript' });
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

/**
 * markdown-it 의 highlight 옵션.
 * 빈 문자열을 반환하면 markdown-it 이 알아서 이스케이프한다 — 그게 안전한 기본 동작이다.
 * 여기서 반환한 HTML 은 markdown-it 이 그대로 넣지만 최종적으로 DOMPurify 를 통과한다.
 *
 * ★ 등록 안 된 언어는 하이라이트 없이 이스케이프된 평문으로 나온다. 깨지지 않는다.
 *   mermaid 도 여기서는 등록되지 않았으므로 평문 코드 블록이 되고,
 *   그 뒤 markMermaidBlocks() 가 표시를 남긴다(6-4절).
 */
export function highlightCode(str: string, lang: string): string {
    if (!lang) return '';
    // ```ts {1,3} 같은 표기 대응
    const name = lang
        .trim()
        .toLowerCase()
        .split(/[\s,{]/)[0];
    if (!hljs.getLanguage(name)) return '';
    try {
        return hljs.highlight(str, { language: name, ignoreIllegals: true }).value;
    } catch {
        return '';
    }
}
