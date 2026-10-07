#!/usr/bin/env node

/**
 * 스토어 등재 문구를 Play Console 에 올린다 (en-US · ko-KR).
 *
 * ★ 문구를 이 파일에 적지 않는다. `release/store-listing.md` 에서 뽑아 쓴다 —
 *   두 곳에 같은 글이 있으면 반드시 한쪽이 낡는다.
 *
 * ★ 스크린샷·아이콘은 여기서 다루지 않는다(play-screenshots.cjs).
 *
 * 사용법:
 *   node scripts/play-listing.cjs --dry     무엇이 올라갈지 보기만 한다
 *   node scripts/play-listing.cjs           실제로 올린다
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const credentialsPath = path.join(repoRoot, 'android', 'play-service-account.json');
const listingPath = path.join(repoRoot, 'release', 'store-listing.md');
// ★ 하드코딩이 의도다. package.json 에서 읽으면 잘못된 앱을 건드리는 사고가 난다.
const PACKAGE_NAME = 'com.marklet.md';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/** 상한. 넘으면 API 가 거부하므로 미리 잡는다. */
const LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };

const TITLE = 'Marklet: Markdown Viewer';
const SHORT = {
    'en-US': 'Opens AI-generated Markdown as-is. Mermaid, tables, math, footnotes.',
    'ko-KR': 'md 파일을 바로 열어 봅니다. 다이어그램·표·수식·각주·초성 검색까지.',
};

/** `## 3. 자세한 설명 — en-US` 같은 절 뒤의 첫 코드블록을 꺼낸다. */
function fullDescription(md, heading) {
    const at = md.indexOf(heading);
    if (at < 0) throw new Error(`절을 찾지 못했습니다: ${heading}`);
    const open = md.indexOf('```', at);
    const close = md.indexOf('```', open + 3);
    if (open < 0 || close < 0) throw new Error(`코드블록을 찾지 못했습니다: ${heading}`);
    return md.slice(open + 3, close).replace(/^\r?\n/, '').trimEnd();
}

const base64url = (input) => Buffer.from(input).toString('base64url');

async function getAccessToken(credentials) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
        JSON.stringify({
            iss: credentials.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now,
        }),
    );
    const signature = crypto
        .createSign('RSA-SHA256')
        .update(`${header}.${claims}`)
        .sign(credentials.private_key, 'base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${header}.${claims}.${signature}`,
        }),
    });
    if (!res.ok) throw new Error(`토큰 발급 실패 ${res.status}: ${await res.text()}`);
    return (await res.json()).access_token;
}

async function main() {
    const dry = process.argv.includes('--dry');
    const md = fs.readFileSync(listingPath, 'utf8');

    const listings = {
        'en-US': {
            language: 'en-US',
            title: TITLE,
            shortDescription: SHORT['en-US'],
            fullDescription: fullDescription(md, '## 3. 자세한 설명 — en-US'),
        },
        'ko-KR': {
            language: 'ko-KR',
            title: TITLE,
            shortDescription: SHORT['ko-KR'],
            fullDescription: fullDescription(md, '## 4. 자세한 설명 — ko-KR'),
        },
    };

    // ── 상한 검사를 먼저. API 에 보내고 거부당하는 것보다 여기서 잡는 쪽이 빠르다.
    let bad = false;
    for (const [lang, l] of Object.entries(listings)) {
        for (const [field, max] of Object.entries(LIMITS)) {
            const len = l[field].length;
            const ok = len <= max;
            if (!ok) bad = true;
            console.log(`  ${ok ? '✓' : '✗'} ${lang} ${field.padEnd(16)} ${len}/${max}`);
        }
    }
    if (bad) {
        console.error('\n❌ 상한을 넘는 항목이 있습니다. release/store-listing.md 를 고치세요.');
        process.exit(1);
    }

    if (dry) {
        console.log('\n--dry 이므로 올리지 않았습니다. 첫 줄 미리보기:');
        for (const [lang, l] of Object.entries(listings)) {
            console.log(`\n[${lang}] ${l.title}`);
            console.log(`  ${l.shortDescription}`);
            console.log(`  ${l.fullDescription.split('\n')[0]} …`);
        }
        return;
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = await getAccessToken(credentials);
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const created = await fetch(`${API}/applications/${PACKAGE_NAME}/edits`, {
        method: 'POST',
        headers: H,
    });
    if (!created.ok) throw new Error(`edit 생성 실패 ${created.status}: ${await created.text()}`);
    const { id } = await created.json();
    console.log(`\nedit ${id}`);

    try {
        for (const [lang, body] of Object.entries(listings)) {
            const res = await fetch(
                `${API}/applications/${PACKAGE_NAME}/edits/${id}/listings/${lang}`,
                { method: 'PUT', headers: H, body: JSON.stringify(body) },
            );
            if (!res.ok) throw new Error(`${lang} 실패 ${res.status}: ${await res.text()}`);
            console.log(`  ${lang} 올림`);
        }

        const commit = await fetch(`${API}/applications/${PACKAGE_NAME}/edits/${id}:commit`, {
            method: 'POST',
            headers: H,
        });
        if (!commit.ok) throw new Error(`커밋 실패 ${commit.status}: ${await commit.text()}`);
        console.log('\n✅ 스토어 등재 문구를 올렸습니다 (en-US · ko-KR).');
    } catch (err) {
        // ★ 실패하면 edit 을 지운다. 남겨 두면 다음 업로드가 "이미 열린 edit" 로 막힌다.
        await fetch(`${API}/applications/${PACKAGE_NAME}/edits/${id}`, {
            method: 'DELETE',
            headers: H,
        }).catch(() => {});
        throw err;
    }
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
