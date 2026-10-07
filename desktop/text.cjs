'use strict';

/**
 * 파일 바이트 ↔ 글자.
 *
 * ★ 읽기와 쓰기가 짝이다. **열린 그대로 저장돼야** 한다 — 인코딩 · BOM · 줄바꿈을 바꿔 쓰면
 *   사용자는 한 글자도 안 고쳤는데 파일이 통째로 달라진다(버전 관리에서는 모든 줄이 바뀐 것으로 보인다).
 */

/**
 * 바이트 → 글자.
 *
 * UTF-16 BOM 을 먼저 보고, 아니면 UTF-8 로 **엄격하게(fatal)** 읽고, 깨지면 EUC-KR(CP949)로 다시 읽는다.
 * 안드로이드 쪽 TextDecoding.java 와 같은 순서에 UTF-16 이 더해졌다. 한국어 윈도우 메모장이 저장한
 * 옛 .txt · .md 가 많다. 관대하게(fatal:false) 읽으면 CP949 파일이 **조용히 깨진 글자로** 열린다.
 *
 * @returns encoding 은 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'EUC-KR', bom 은 UTF-8 BOM 이 있었는가
 *   (UTF-16 은 BOM 이 형식의 일부라 항상 쓴다)
 */
function decodeText(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'UTF-16LE', bom: true };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'UTF-16BE', bom: true };
    }
    try {
        let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
        // BOM 은 글자가 아니다. 남기면 첫 줄의 제목 표시가 제목으로 안 읽힌다.
        const bom = text.charCodeAt(0) === 0xfeff;
        if (bom) text = text.slice(1);
        return { text, encoding: 'UTF-8', bom };
    } catch {
        return { text: new TextDecoder('euc-kr').decode(buf), encoding: 'EUC-KR', bom: false };
    }
}

/** EUC-KR 의 글자 → 바이트 표. 첫 저장 때 한 번만 만든다(약 2만 4천 칸). */
let eucKrTable = null;
function eucKrEncodeTable() {
    if (eucKrTable) return eucKrTable;
    const dec = new TextDecoder('euc-kr');
    const map = new Map();
    for (let lead = 0x81; lead <= 0xfe; lead++) {
        for (let trail = 0x41; trail <= 0xfe; trail++) {
            const ch = dec.decode(Uint8Array.of(lead, trail));
            // 짝이 안 맞으면 대치 문자(U+FFFD)나 두 글자(앞 바이트 + ASCII)가 나온다. 한 글자만 표에 넣는다.
            if (ch.length === 1 && ch.charCodeAt(0) !== 0xfffd && !map.has(ch))
                map.set(ch, [lead, trail]);
        }
    }
    eucKrTable = map;
    return map;
}

/**
 * 글자 → 바이트. 읽을 때의 인코딩으로 되돌려 쓴다.
 * @returns Buffer. EUC-KR 로 표현 못 하는 글자(이모지 등)가 있으면 null — 부르는 쪽이 UTF-8 로 바꿀지 묻는다.
 */
function encodeText(text, encoding, bom) {
    if (encoding === 'UTF-16LE') {
        return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    }
    if (encoding === 'UTF-16BE') {
        return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    }
    if (encoding === 'EUC-KR') {
        const table = eucKrEncodeTable();
        const out = [];
        for (const ch of text) {
            if (ch.charCodeAt(0) < 0x80) {
                out.push(ch.charCodeAt(0));
                continue;
            }
            const pair = table.get(ch);
            if (!pair) return null;
            out.push(pair[0], pair[1]);
        }
        return Buffer.from(out);
    }
    return Buffer.from((bom ? String.fromCharCode(0xfeff) : '') + text, 'utf8');
}

/** 줄바꿈 방식. 섞여 있으면 많은 쪽을 따른다. */
function detectEol(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/(?<!\r)\n/g) || []).length;
    return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/** 화면의 글자(LF)를 파일의 줄바꿈으로 되돌린다. */
function applyEol(text, eol) {
    const lf = text.replace(/\r\n?/g, '\n');
    return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/** 이 앱이 문서로 여는 확장자. .txt 는 서식 없이 글자 그대로 보여 준다. */
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];

/** 문서가 참조하는 그림으로 허용하는 확장자. SVG 는 <img> 로만 쓰이므로 스크립트가 돌지 않는다. */
const IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.svg',
    '.ico',
    '.avif',
];

function hasExt(file, list) {
    const i = file.lastIndexOf('.');
    return i >= 0 && list.includes(file.slice(i).toLowerCase());
}

module.exports = {
    decodeText,
    encodeText,
    detectEol,
    applyEol,
    DOC_EXTENSIONS,
    IMAGE_EXTENSIONS,
    hasExt,
};
