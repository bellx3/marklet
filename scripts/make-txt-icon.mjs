/**
 * `.txt` 문서 아이콘 만들기 — `npm run icons`  →  src-tauri/icons/txt.ico
 *
 * 탐색기는 파일 형식(ProgID)의 DefaultIcon 으로 아이콘을 그린다. 지금까지 `.md` 와 `.txt` 가 둘 다 앱 아이콘(Marklet.exe,0)이라
 * 폴더에서 두 종류가 한 모양으로 보였다. 앱 아이콘(어두운 바탕 + 종이 + 체크)과 한 식구로 보이되 **바탕 색과 모양이 다른** 아이콘을
 * 따로 둔다: 파란 바탕 · 같은 종이 · 글줄 넷 · 작은 `TXT`. 설치기가 `Marklet.Text` 의 DefaultIcon 으로 쓴다(src-tauri/installer-hooks.nsh).
 *
 * ★ 벡터로 크기마다 새로 그린다(큰 것을 줄이지 않는다). 32px 이하는 줄 수를 늘리지 않고 굵게 · `TXT` 는 뺀다 — 작은 크기에서는 뭉개져 오히려 지저분하다.
 * ★ `TXT` 는 글꼴이 아니라 선으로 그린다 — 어느 PC 에서 돌려도 같은 결과가 나오도록.
 * ★ 항목 형식: 256px 만 PNG, 나머지는 고전적인 32비트 DIB 다. 모든 크기를 PNG 로 담으면 Win32 로더(탐색기)는 읽지만
 *   .NET 의 System.Drawing.Icon 은 48px 이상 항목에서 터진다(실측, 2026-10-08). DIB + 256 PNG 는 XP 이후 어떤 로더든 읽는다.
 * 파일은 저장소에 두고, 모양을 바꿀 때만 다시 만든다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src-tauri', 'icons', 'txt.ico');
// 탐색기 보기 크기와 화면 배율(100~250%)에 맞는 크기들
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const PAPER = '#f4f2ee'; // 앱 아이콘의 종이 색
const INK = '#121b22'; // 앱 아이콘의 글줄 색
const TILE_TOP = '#2f70dc';
const TILE_BOTTOM = '#1f56b4';
const LABEL = '#2563c9';

function svg(size) {
    const small = size <= 32;
    // 512 좌표계. 종이는 앱 아이콘과 같은 자리(104,87)–(408,423)에 둔다.
    const lines = small
        ? [
              [150, 148, 362],
              [150, 224, 362],
              [150, 300, 362],
              [150, 376, 266],
          ]
        : [
              [150, 140, 362],
              [150, 190, 362],
              [150, 240, 362],
              [150, 290, 362],
          ];
    const stroke = small ? 34 : 22;
    const body = lines
        .map(([x1, y, x2]) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${INK}" stroke-width="${stroke}" stroke-linecap="round"/>`)
        .join('');
    const label = small
        ? ''
        : `<g stroke="${LABEL}" stroke-width="13" fill="none" stroke-linecap="butt">
             <path d="M150 352h46M173 352v52"/>
             <path d="M211 352l44 52M255 352l-44 52"/>
             <path d="M270 352h46M293 352v52"/>
           </g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TILE_TOP}"/><stop offset="1" stop-color="${TILE_BOTTOM}"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <rect x="104" y="87" width="304" height="336" rx="8" fill="${PAPER}"/>
  ${body}
  ${label}
</svg>`;
}

/** RGBA(위에서 아래로) → ICO 안의 32비트 DIB(BITMAPINFOHEADER + 아래에서 위로 BGRA + 빈 AND 마스크). */
function dib(w, h, rgba) {
    const head = Buffer.alloc(40);
    head.writeUInt32LE(40, 0); // biSize
    head.writeInt32LE(w, 4);
    head.writeInt32LE(h * 2, 8); // 높이는 XOR 몸통 + AND 마스크의 합
    head.writeUInt16LE(1, 12); // planes
    head.writeUInt16LE(32, 14); // bpp
    const xor = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = ((h - 1 - y) * w + x) * 4;
            const d = (y * w + x) * 4;
            xor[d] = rgba[s + 2]; // B
            xor[d + 1] = rgba[s + 1]; // G
            xor[d + 2] = rgba[s]; // R
            xor[d + 3] = rgba[s + 3]; // A
        }
    }
    const mask = Buffer.alloc(Math.ceil(w / 32) * 4 * h); // 모두 0 — 투명도는 알파가 맡는다
    return Buffer.concat([head, xor, mask]);
}

/** ICONDIR + ICONDIRENTRY × n + 항목 본문. */
function packIco(entries) {
    const head = Buffer.alloc(6);
    head.writeUInt16LE(0, 0); // reserved
    head.writeUInt16LE(1, 2); // type: icon
    head.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length);
    let offset = 6 + dir.length;
    entries.forEach(({ size, data }, i) => {
        const o = i * 16;
        dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
        dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
        dir.writeUInt8(0, o + 2); // palette
        dir.writeUInt8(0, o + 3); // reserved
        dir.writeUInt16LE(1, o + 4); // planes
        dir.writeUInt16LE(32, o + 6); // bpp
        dir.writeUInt32LE(data.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += data.length;
    });
    return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

const entries = [];
for (const size of SIZES) {
    const img = sharp(Buffer.from(svg(size))).ensureAlpha();
    if (size >= 256) {
        entries.push({ size, data: await img.png({ compressionLevel: 9 }).toBuffer() });
    } else {
        const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
        entries.push({ size, data: dib(info.width, info.height, data) });
    }
}
const ico = packIco(entries);
fs.writeFileSync(OUT, ico);
console.log(`${path.relative(ROOT, OUT)} — ${SIZES.join(' · ')} px, ${(ico.length / 1024).toFixed(1)} KB`);
