'use strict';

/**
 * 파일 바이트 → 글자.
 *
 * ★ UTF-8 로 엄격하게(fatal) 먼저 읽고, 깨지면 EUC-KR(CP949)로 다시 읽는다.
 *   안드로이드 쪽 TextDecoding.java 와 같은 순서다. 한국어 윈도우 메모장이 저장한 옛 .md 가 많다.
 *   관대하게(fatal:false) 읽으면 CP949 파일이 **조용히 깨진 글자로** 열린다.
 */
function decodeText(buf) {
    let text;
    let encoding = 'UTF-8';
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        text = new TextDecoder('euc-kr').decode(buf);
        encoding = 'EUC-KR';
    }
    // BOM 은 글자가 아니다. 남기면 첫 줄의 제목 표시가 제목으로 안 읽힌다.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, encoding };
}

/** 이 앱이 문서로 여는 확장자. electron-builder 의 fileAssociations 와 같은 목록이어야 한다. */
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

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

module.exports = { decodeText, DOC_EXTENSIONS, IMAGE_EXTENSIONS, hasExt };
