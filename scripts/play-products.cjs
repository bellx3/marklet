#!/usr/bin/env node

/**
 * 인앱 상품이 **구글 서버 쪽에서** 어떤 상태인지 조회한다.
 *
 * 왜 필요한가 — "앱에서 후원 버튼이 비활성이다" 의 원인은 셋인데 기기만 봐서는 안 갈린다.
 *   ① 상품이 활성이 아니다        → 여기서 status 로 보인다
 *   ② 아직 전파되지 않았다        → 여기서는 보이는데 기기에서만 안 보인다
 *   ③ 앱/플러그인 문제            → 여기서도 보이고 전파도 끝났는데 안 보인다
 *
 * ★ 우리 플러그인(cordova-plugin-purchase 13)은 **구버전 API** 로 상품을 읽는다.
 *   그래서 일부러 구버전 엔드포인트(inappproducts)를 쓴다 —
 *   콘솔의 새 '일회성 제품' 이 구버전 경로로도 보이는지가 바로 이 앱의 관심사다.
 *
 * 사용법: npm run play:products
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const credentialsPath = path.join(repoRoot, 'android', 'play-service-account.json');
// ★ 하드코딩이 의도다. package.json 에서 읽으면 잘못된 앱을 건드리는 사고가 난다.
const PACKAGE_NAME = 'com.marklet.md';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

const base64url = (input) => Buffer.from(input).toString('base64url');

async function getAccessToken(credentials) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
        JSON.stringify({
            iss: credentials.client_email,
            scope: SCOPE,
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
    if (!fs.existsSync(credentialsPath)) {
        console.error('❌ android/play-service-account.json 이 없습니다.');
        process.exit(1);
    }
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = await getAccessToken(credentials);

    const res = await fetch(`${API}/applications/${PACKAGE_NAME}/inappproducts`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        console.error(`❌ ${res.status}: ${await res.text()}`);
        process.exit(1);
    }

    const { inappproduct = [] } = await res.json();
    console.log(`📦 ${PACKAGE_NAME} — 구버전 API 가 보는 인앱 상품 ${inappproduct.length}개\n`);

    if (inappproduct.length === 0) {
        console.log('   (없음) — 구버전 경로로는 상품이 보이지 않습니다.');
        console.log('   콘솔에서 만든 새 "일회성 제품" 에 [이전 버전과의 호환성] 배지가 있는지 확인하세요.');
        return;
    }

    for (const p of inappproduct) {
        const krw = p.prices?.KR;
        console.log(`━━ ${p.sku}`);
        console.log(`   상태     : ${p.status}`);
        console.log(`   유형     : ${p.purchaseType}`);
        console.log(`   기본가   : ${p.defaultPrice?.priceMicros ?? '-'} (${p.defaultPrice?.currency ?? '-'})`);
        console.log(`   대한민국 : ${krw ? `${Number(krw.priceMicros) / 1e6} ${krw.currency}` : '★ 없음'}`);
        console.log(`   가격국가 : ${Object.keys(p.prices ?? {}).length}개`);
        console.log(`   이름     : ${p.listings?.['en-US']?.title ?? '-'}`);
    }
}

main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
});
