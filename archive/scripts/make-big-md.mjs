#!/usr/bin/env node

/**
 * 성능 실측용 마크다운을 만든다.
 *
 *   node scripts/make-big-md.mjs <출력경로> <목표KB>
 *
 * ★ 그냥 같은 문단을 반복하면 안 된다. 실제 문서는 제목·목록·표·코드·링크가 섞여 있고,
 *   그 비율이 파싱 비용과 청크 나누기(TOKENS_PER_CHUNK)를 좌우한다.
 *   한 덩이에 여러 종류를 섞어 실제 문서의 밀도를 흉내 낸다.
 */

import { writeFileSync } from 'node:fs';

const [out, kbArg] = process.argv.slice(2);
if (!out || !kbArg) {
    console.error('사용: node scripts/make-big-md.mjs <출력경로> <목표KB>');
    process.exit(1);
}
const targetBytes = Number(kbArg) * 1024;

const WORDS = [
    '문서',
    '마크다운',
    '뷰어',
    '설정',
    '검색',
    '초안',
    '저장',
    '다이어그램',
    '수식',
    '코드',
    '폴더',
    '권한',
    '렌더',
    '청크',
    '테마',
];

/** 결정적 난수 — 같은 인자면 같은 파일이 나와야 비교가 된다. */
let seed = 12345;
function rnd(n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
}
const sentence = (n) =>
    Array.from({ length: n }, () => WORDS[rnd(WORDS.length)]).join(' ') + '.';

function section(i) {
    const parts = [];
    parts.push(`\n## ${i}. ${WORDS[rnd(WORDS.length)]} ${WORDS[rnd(WORDS.length)]}\n`);
    parts.push(sentence(20) + ' ' + sentence(18) + '\n');
    parts.push(`### ${i}.1 ${WORDS[rnd(WORDS.length)]}\n`);
    parts.push(sentence(24) + '\n');

    parts.push('- ' + sentence(8));
    parts.push('- ' + sentence(9));
    parts.push('- ' + sentence(7) + '\n');

    parts.push('| 항목 | 값 | 설명 |');
    parts.push('| --- | --- | --- |');
    for (let r = 0; r < 4; r++) {
        parts.push(`| ${WORDS[rnd(WORDS.length)]} | ${rnd(1000)} | ${sentence(4)} |`);
    }
    parts.push('');

    parts.push('```ts');
    parts.push(`// ${sentence(5)}`);
    parts.push(`export function step${i}(x: number): number {`);
    parts.push('    if (x < 0) return 0;');
    parts.push(`    return x * ${rnd(9) + 1} + ${rnd(100)};`);
    parts.push('}');
    parts.push('```\n');

    parts.push(`> ${sentence(12)}\n`);
    parts.push(`[${WORDS[rnd(WORDS.length)]}](https://example.com/${i}) · **${sentence(3)}**\n`);
    return parts.join('\n');
}

const head = [
    '---',
    'title: 성능 실측용 문서',
    'author: marklet',
    '---',
    '',
    '# 성능 실측용 문서',
    '',
    '이 문서는 큰 문서에서의 열기·검색·목차 이동 시간을 재기 위해 만들어졌습니다.',
    '',
    '## 찾을 말',
    '',
    '문서 맨 앞의 표시입니다: ALPHA_MARKER_START',
    '',
].join('\n');

let body = '';
let i = 1;
const encoder = new TextEncoder();
while (encoder.encode(head + body).length < targetBytes - 200) {
    body += section(i++);
}

// ★ 맨 끝에 표시를 둔다. 검색이 문서 뒷부분까지 훑는지 보려면 필요하다.
const tail = '\n\n## 맺음말\n\n문서 맨 끝의 표시입니다: OMEGA_MARKER_END\n';

const text = head + body + tail;
writeFileSync(out, text, 'utf8');

const bytes = encoder.encode(text).length;
console.log(
    `${out}  ${(bytes / 1024).toFixed(0)}KB  ${i - 1}개 절  ${text.split('\n').length}줄`,
);
