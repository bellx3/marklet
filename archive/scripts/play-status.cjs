#!/usr/bin/env node

/**
 * Play Console 트랙 상태 조회
 *
 * 업로드한 버전이 각 트랙에서 실제로 어떤 상태인지 확인합니다.
 * (검토 중인지, 배포됐는지, 어떤 버전이 활성인지)
 *
 * gradlew 를 거치지 않고 Android Publisher API 를 직접 호출합니다.
 * Node 내장 crypto 로 JWT 를 만들어 OAuth 토큰을 받으므로 의존성이 하나도 없습니다.
 *
 * 사용법: npm run play:status
 *        npm run play:status -- --raw    국가 타겟팅 등 원본 필드까지
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const credentialsPath = path.join(repoRoot, 'android', 'play-service-account.json');
// ★ 하드코딩이 의도다. package.json 에서 읽으면 잘못된 앱의 edit 을 지우는 사고가 난다.
const PACKAGE_NAME = 'com.marklet.md';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

/** 서비스 계정 키로 OAuth 액세스 토큰 발급 */
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
        .sign(credentials.private_key)
        .toString('base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${header}.${claims}.${signature}`,
        }),
    });

    const body = await res.json();
    if (!res.ok) throw new Error(`토큰 발급 실패: ${JSON.stringify(body)}`);
    return body.access_token;
}

async function api(token, urlPath, options = {}) {
    const res = await fetch(`${API}${urlPath}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${urlPath} → ${res.status}: ${JSON.stringify(body)}`);
    return body;
}

async function main() {
    if (!fs.existsSync(credentialsPath)) {
        console.error('❌ 서비스 계정 키가 없습니다:', credentialsPath);
        console.error('   발급 방법은 .docs/설계문서/03_출시_절차서.md 1-6·1-7절을 참고하세요.');
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const token = await getAccessToken(credentials);

    // 트랙 조회는 edit 컨텍스트가 필요합니다. 조회만 하고 바로 폐기합니다.
    const edit = await api(token, `/applications/${PACKAGE_NAME}/edits`, { method: 'POST' });

    try {
        const { tracks = [] } = await api(
            token,
            `/applications/${PACKAGE_NAME}/edits/${edit.id}/tracks`,
        );

        console.log(`📦 ${PACKAGE_NAME}\n`);

        // --raw: 국가 타겟팅 등 원본 필드까지 확인할 때 사용
        if (process.argv.includes('--raw')) {
            const internal = tracks.find((t) => t.track === 'internal');
            console.log(JSON.stringify(internal ?? tracks, null, 2));
            return;
        }

        for (const track of tracks) {
            console.log(`━━ ${track.track} ━━`);

            if (!track.releases?.length) {
                console.log('   (출시 없음)\n');
                continue;
            }

            for (const release of track.releases) {
                console.log(`   상태       : ${release.status}`);
                console.log(`   버전 코드  : ${(release.versionCodes ?? ['-']).join(', ')}`);
                if (release.name) console.log(`   출시 이름  : ${release.name}`);
                if (release.userFraction !== undefined) {
                    console.log(`   배포 비율  : ${release.userFraction * 100}%`);
                }
                console.log('');
            }
        }
    } finally {
        // ★ 조회용 edit 을 반드시 지운다. 안 지우면 콘솔에 "검토 중인 변경사항"으로 남아
        //   다음 업로드를 막는다(03_출시_절차서.md 8장 함정 9).
        await api(token, `/applications/${PACKAGE_NAME}/edits/${edit.id}`, {
            method: 'DELETE',
        }).catch(() => {});
    }
}

main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
});
