/**
 * 이미 올라간 빌드를 다른 트랙에도 넣는다 (승격).
 *
 * ⚠️ **같은 versionCode 를 두 번 업로드할 수 없다.**
 *
 *     Version code is too low or has already been used for app com.marklet.md
 *
 * 한 번 올린 AAB 를 다른 트랙에서도 쓰려면 파일을 다시 보내는 것이 아니라
 * **그 versionCode 를 그 트랙의 출시로 지정**해야 한다. publish.cjs 로는 안 된다.
 *
 * 실행:
 *   node scripts/promote.cjs <versionCode> <트랙> [--status=completed|draft]
 *   node scripts/promote.cjs 10002 internal
 *
 * 상태 기본값은 publish.cjs 와 같은 규칙이다 — internal 은 심사를 안 거치므로
 * completed, 그 밖은 미게시 앱이면 draft 만 받는다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const credentialsPath = path.join(repoRoot, 'android', 'play-service-account.json');
const PKG = require(path.join(repoRoot, 'capacitor.config.json')).appId;
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const VALID_TRACKS = ['internal', 'alpha', 'beta', 'production'];

const b64 = (s) => Buffer.from(s).toString('base64url');

async function token(creds) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const cl = b64(
        JSON.stringify({
            iss: creds.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now,
        }),
    );
    const sig = crypto
        .createSign('RSA-SHA256')
        .update(`${h}.${cl}`)
        .sign(creds.private_key)
        .toString('base64url');
    const r = await (
        await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: `${h}.${cl}.${sig}`,
            }),
        })
    ).json();
    if (!r.access_token) throw new Error(`토큰 발급 실패: ${JSON.stringify(r)}`);
    return r.access_token;
}

/** 릴리스 노트는 저장소 파일이 정본이다 */
function releaseNotes() {
    const dir = path.join(repoRoot, 'android', 'app', 'src', 'main', 'play', 'release-notes');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .map((lang) => {
            const p = path.join(dir, lang, 'default.txt');
            if (!fs.existsSync(p)) return null;
            return { language: lang, text: fs.readFileSync(p, 'utf8').replace(/\r/g, '').trimEnd() };
        })
        .filter(Boolean);
}

(async () => {
    const codeArg = process.argv[2];
    const track = process.argv[3];
    const flag = process.argv.find((a) => a.startsWith('--status='));

    if (!/^\d+$/.test(codeArg ?? '') || !VALID_TRACKS.includes(track)) {
        console.error('사용법: node scripts/promote.cjs <versionCode> <트랙> [--status=...]');
        console.error(`  트랙: ${VALID_TRACKS.join(', ')}`);
        process.exit(1);
    }
    const versionCode = Number(codeArg);
    const status = flag ? flag.split('=')[1] : track === 'internal' ? 'completed' : 'draft';

    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const t = await token(creds);
    const call = async (p, o = {}) => {
        const r = await fetch(API + p, {
            ...o,
            headers: { Authorization: `Bearer ${t}`, ...(o.headers ?? {}) },
        });
        const x = await r.text();
        let body = {};
        try {
            body = x ? JSON.parse(x) : {};
        } catch {
            body = { raw: x.slice(0, 200) };
        }
        return { ok: r.ok, status: r.status, body };
    };

    const ins = await call(`/applications/${PKG}/edits`, { method: 'POST' });
    if (!ins.ok) throw new Error(`편집본 생성 실패 ${ins.status}`);
    const id = ins.body.id;
    let committed = false;

    try {
        // 그 versionCode 가 실제로 존재하는지 먼저 본다
        const bundles = await call(`/applications/${PKG}/edits/${id}/bundles`);
        const codes = (bundles.body.bundles ?? []).map((b) => b.versionCode);
        if (codes.length && !codes.includes(versionCode)) {
            throw new Error(`versionCode ${versionCode} 를 못 찾았습니다. 올라온 것: ${codes.join(', ')}`);
        }

        const notes = releaseNotes();
        const up = await call(`/applications/${PKG}/edits/${id}/tracks/${track}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                track,
                releases: [{ versionCodes: [String(versionCode)], status, releaseNotes: notes }],
            }),
        });
        if (!up.ok) throw new Error(`트랙 쓰기 실패 ${up.status}: ${JSON.stringify(up.body).slice(0, 200)}`);

        const v = await call(`/applications/${PKG}/edits/${id}:validate`, { method: 'POST' });
        if (!v.ok) throw new Error(`검증 실패: ${v.body?.error?.message ?? v.status}`);

        const cm = await call(`/applications/${PKG}/edits/${id}:commit`, { method: 'POST' });
        if (!cm.ok) throw new Error(`commit 실패 ${cm.status}: ${JSON.stringify(cm.body).slice(0, 200)}`);
        committed = true;
    } finally {
        if (!committed) await call(`/applications/${PKG}/edits/${id}`, { method: 'DELETE' });
    }

    // ★ 올렸다고 말하기 전에 읽어 본다 (publish.cjs 와 같은 이유)
    const id2 = (await call(`/applications/${PKG}/edits`, { method: 'POST' })).body.id;
    const got = await call(`/applications/${PKG}/edits/${id2}/tracks/${track}`);
    await call(`/applications/${PKG}/edits/${id2}`, { method: 'DELETE' });

    const rel = (got.body.releases ?? []).find((r) => (r.versionCodes ?? []).includes(String(versionCode)));
    if (!rel) {
        console.error(`❌ commit 은 됐는데 ${track} 트랙에서 ${versionCode} 를 못 찾았습니다.`);
        process.exit(1);
    }
    console.log(`✅ ${versionCode} → ${track} 트랙 (상태: ${rel.status})`);
    console.log(`   노트: ${(rel.releaseNotes ?? []).map((n) => n.language).join(', ') || '없음'}`);
})().catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
});
