/**
 * 코드에 박혀 있는 한국어 문자열을 센다 (i18n 작업 보조).
 *
 * ★ 주석은 세지 않는다 — 이 저장소는 주석에 근거를 길게 적어 두었고 그건 옮길 대상이 아니다.
 *   문자열 리터럴 안의 한글만 본다.
 *
 *   사용: node scripts/scan-korean.mjs [--list]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HANGUL = /[가-힣]/;
const LITERAL = /'[^'\\\n]*'|"[^"\\\n]*"|`[^`\\]*`/g;
const list = process.argv.includes('--list');

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
    }
    return out;
}

let total = 0;
for (const file of walk('src')) {
    const hits = [];
    readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
            const s = line.trim();
            if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
            for (const lit of line.match(LITERAL) ?? []) {
                if (HANGUL.test(lit)) hits.push(`${i + 1}: ${lit.slice(0, 70)}`);
            }
        });
    if (hits.length) {
        console.log(`${String(hits.length).padStart(4)}  ${file.replace(/\\/g, '/')}`);
        if (list) for (const h of hits) console.log(`        ${h}`);
        total += hits.length;
    }
}
console.log(`${String(total).padStart(4)}  합계`);
