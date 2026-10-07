/**
 * store/ 아래의 등재 문구를 Play에 반영한다.
 *
 * 손으로 옮기면 1,500자짜리 문단에서 줄바꿈이 깨지거나 한 줄이 빠져도 모른다.
 * 파일을 정본으로 두고 여기서 밀어 넣으면 저장소와 스토어가 어긋나지 않는다.
 *
 * ⚠️ **listings.update는 항목을 통째로 갈아 끼운다.** title만 보내면 나머지가
 * 빈 값이 된다. 그래서 지금 값을 먼저 읽어 **파일이 있는 칸만 덮어쓰고 나머지는
 * 그대로 되돌려 보낸다.**
 *
 * 흐름: edits.insert → listings.update → validate → commit
 * validate에서 걸리면 commit하지 않고 편집본을 버린다.
 *
 * 실행: node scripts/push-listing.cjs [--dry]
 *   --dry 를 주면 validate까지만 하고 commit하지 않는다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const creds = JSON.parse(fs.readFileSync(path.join(root, 'android', 'play-service-account.json'), 'utf8'));
const PKG = 'com.marklet.md';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const DRY = process.argv.includes('--dry');

/**
 * 파일이 있으면 그 내용을, 없으면 null (= 지금 값 유지)
 *
 * ⚠️ **CR을 반드시 걷어낸다.** 윈도에서 저장하면 줄마다 `\r`이 붙는데, Play는
 * 그걸 버리고 `\n`만 저장한다. 안 걷어내면 이쪽 글자수가 줄 수만큼 부풀어
 * **상한 검사가 헐거워진다** — 4000자 상한에 3960자라고 믿었는데 실제로는
 * 넘어가 있을 수 있다. 실제로 1,577 대 1,513으로 65자 어긋났다.
 */
function read(lang, name) {
    const p = path.join(root, 'store', lang, `${name}.txt`);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').replace(/\r/g, '').replace(/\s+$/, '');
}

const LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };
const len = (s) => [...(s ?? '')].length;

const b64 = (s) => Buffer.from(s).toString('base64url');

async function token() {
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

async function call(t, p, o = {}) {
    const res = await fetch(API + p, {
        ...o,
        headers: { Authorization: `Bearer ${t}`, ...(o.headers ?? {}) },
    });
    const x = await res.text();
    let body = {};
    try {
        body = x ? JSON.parse(x) : {};
    } catch {
        body = { raw: x.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, body };
}

(async () => {
    const t = await token();
    const ins = await call(t, `/applications/${PKG}/edits`, { method: 'POST' });
    if (!ins.ok) throw new Error(`편집본 생성 실패 ${ins.status}`);
    const id = ins.body.id;
    let committed = false;

    try {
        const cur = (await call(t, `/applications/${PKG}/edits/${id}/listings`)).body.listings ?? [];
        const changes = [];

        for (const lang of fs.readdirSync(path.join(root, 'store'))) {
            const dir = path.join(root, 'store', lang);
            if (!fs.statSync(dir).isDirectory()) continue;

            const now = cur.find((x) => x.language === lang);
            if (!now) {
                console.log(`⚠️  ${lang}: 스토어에 없는 언어입니다. 건너뜁니다.`);
                continue;
            }

            // 지금 값을 바탕으로, 파일이 있는 칸만 덮어쓴다
            const next = {
                language: lang,
                title: read(lang, 'title') ?? now.title,
                shortDescription: read(lang, 'short-description') ?? now.shortDescription,
                fullDescription: read(lang, 'full-description') ?? now.fullDescription,
                video: now.video ?? '',
            };

            for (const [k, max] of Object.entries(LIMITS)) {
                if (len(next[k]) > max) {
                    throw new Error(`${lang} ${k}: ${len(next[k])}자 > 상한 ${max}자`);
                }
                if (next[k] !== now[k]) {
                    changes.push(`  ${lang} ${k.padEnd(16)} ${len(now[k])} → ${len(next[k])}자`);
                }
            }

            const w = await call(t, `/applications/${PKG}/edits/${id}/listings/${lang}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(next),
            });
            if (!w.ok) throw new Error(`${lang} 쓰기 실패 ${w.status}: ${JSON.stringify(w.body).slice(0, 200)}`);
        }

        console.log(changes.length ? '바뀌는 것:\n' + changes.join('\n') : '바뀌는 것 없음');

        const v = await call(t, `/applications/${PKG}/edits/${id}:validate`, { method: 'POST' });
        console.log(`\nvalidate: ${v.status} ${v.ok ? '통과' : '거부'}`);
        if (!v.ok) throw new Error(v.body?.error?.message ?? '검증 실패');

        if (DRY) {
            console.log('\n--dry 이므로 commit하지 않습니다.');
            return;
        }

        const cm = await call(t, `/applications/${PKG}/edits/${id}:commit`, { method: 'POST' });
        if (!cm.ok) throw new Error(`commit 실패 ${cm.status}: ${JSON.stringify(cm.body).slice(0, 200)}`);
        committed = true;
        console.log('\n✅ 반영했습니다.');
    } finally {
        // commit한 편집본은 이미 소비됐다. 실패했거나 dry면 버린다.
        if (!committed) {
            await call(t, `/applications/${PKG}/edits/${id}`, { method: 'DELETE' });
            console.log('(편집본 폐기 — 반영된 것 없음)');
        }
    }
})().catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
});
