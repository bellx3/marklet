#!/usr/bin/env node

/**
 * 스토어 스크린샷을 올린다 (release/screenshots/<locale>/*.png).
 *
 * ★ 올리기 전에 규격을 여기서 검사한다. Play 의 거부 메시지는 어느 파일인지 알려 주지 않는다.
 *   - 24비트 PNG (알파 없음)
 *   - 각 변 320~3840px
 *   - **긴 변이 짧은 변의 2배 이하** ← 요즘 폰 해상도가 여기 걸린다
 *   - 언어당 2~8장
 *
 * ★ 기존 스크린샷은 **전부 지우고 새로 올린다.** 덮어쓰기가 아니라 추가라서,
 *   지우지 않으면 옛 화면이 섞여 남는다.
 *
 * 사용법:
 *   node scripts/play-screenshots.cjs --dry
 *   node scripts/play-screenshots.cjs
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const credentialsPath = path.join(repoRoot, 'android', 'play-service-account.json');
const shotsRoot = path.join(repoRoot, 'release', 'screenshots');
// ★ 하드코딩이 의도다. package.json 에서 읽으면 잘못된 앱을 건드리는 사고가 난다.
const PACKAGE_NAME = 'com.marklet.md';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const IMAGE_TYPE = 'phoneScreenshots';

/** PNG 헤더에서 크기와 컬러 타입을 읽는다. 라이브러리 없이 충분하다. */
function readPng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 가 아닙니다');
    return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        // 6 = RGBA, 4 = 그레이+알파 → Play 가 거부한다
        colorType: buf.readUInt8(25),
    };
}

function check(file) {
    const buf = fs.readFileSync(file);
    const { width, height, colorType } = readPng(buf);
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const problems = [];
    if (colorType === 4 || colorType === 6) problems.push('알파 채널이 있다 (24비트 PNG 여야 한다)');
    if (short < 320) problems.push(`짧은 변 ${short}px < 320`);
    if (long > 3840) problems.push(`긴 변 ${long}px > 3840`);
    if (long > short * 2) problems.push(`비율 ${(long / short).toFixed(2)} > 2.00`);
    return { width, height, buf, problems };
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
    const locales = fs.readdirSync(shotsRoot).filter((d) => /^[a-z]{2}-[A-Z]{2}$/.test(d));
    if (locales.length === 0) throw new Error(`${shotsRoot} 에 로케일 폴더가 없습니다.`);

    const plan = {};
    let bad = false;
    for (const locale of locales) {
        const dir = path.join(shotsRoot, locale);
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
        console.log(`\n[${locale}] ${files.length}장`);
        if (files.length < 2 || files.length > 8) {
            console.log(`  ✗ 언어당 2~8장이어야 합니다`);
            bad = true;
        }
        plan[locale] = [];
        for (const f of files) {
            const r = check(path.join(dir, f));
            if (r.problems.length) bad = true;
            console.log(
                `  ${r.problems.length ? '✗' : '✓'} ${f.padEnd(18)} ${r.width}x${r.height}` +
                    (r.problems.length ? `  ${r.problems.join(', ')}` : ''),
            );
            plan[locale].push({ name: f, buf: r.buf });
        }
    }
    if (bad) {
        console.error('\n❌ 규격에 맞지 않는 파일이 있습니다.');
        process.exit(1);
    }
    if (dry) {
        console.log('\n--dry 이므로 올리지 않았습니다.');
        return;
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = await getAccessToken(credentials);
    const H = { Authorization: `Bearer ${token}` };

    const created = await fetch(`${API}/applications/${PACKAGE_NAME}/edits`, {
        method: 'POST',
        headers: H,
    });
    if (!created.ok) throw new Error(`edit 생성 실패 ${created.status}: ${await created.text()}`);
    const { id } = await created.json();
    console.log(`\nedit ${id}`);

    try {
        for (const [locale, shots] of Object.entries(plan)) {
            // ★ 먼저 비운다. 안 그러면 옛 스크린샷 뒤에 새것이 덧붙는다.
            const del = await fetch(
                `${API}/applications/${PACKAGE_NAME}/edits/${id}/listings/${locale}/${IMAGE_TYPE}`,
                { method: 'DELETE', headers: H },
            );
            if (!del.ok && del.status !== 404) {
                throw new Error(`${locale} 비우기 실패 ${del.status}: ${await del.text()}`);
            }

            for (const s of shots) {
                const res = await fetch(
                    `${UPLOAD}/applications/${PACKAGE_NAME}/edits/${id}/listings/${locale}/${IMAGE_TYPE}?uploadType=media`,
                    { method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: s.buf },
                );
                if (!res.ok) {
                    throw new Error(`${locale}/${s.name} 실패 ${res.status}: ${await res.text()}`);
                }
                console.log(`  ${locale}/${s.name} 올림`);
            }
        }

        const commit = await fetch(`${API}/applications/${PACKAGE_NAME}/edits/${id}:commit`, {
            method: 'POST',
            headers: H,
        });
        if (!commit.ok) throw new Error(`커밋 실패 ${commit.status}: ${await commit.text()}`);
        console.log('\n✅ 스크린샷을 올렸습니다.');
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
