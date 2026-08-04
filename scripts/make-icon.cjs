/**
 * store/assets/app-icon-512.png 하나에서 런처 아이콘을 전부 뽑는다.
 *
 * ── 적응형 아이콘의 함정
 * 안드로이드 8 이상은 `ic_launcher_foreground` 를 배경 위에 얹고 **런처가 정한
 * 모양으로 잘라 낸다.** 그런데 그 마스크는 캔버스의 가운데 **72%** 원 안쪽만
 * 확실히 보이는 자리다(기기마다 원·둥근네모·물방울로 다르다). 그래서 512
 * 원본을 그대로 전경에 넣으면 **가장자리가 잘린다.**
 *
 * 여기서는 원본을 안전 영역에 맞춰 축소하고(SAFE 참고) 둘레를 투명하게 채운다.
 * 원본 아이콘이 이미 종이 둘레에 여백을 두고 있으므로 두 번 줄지 않게
 * 배경색과 같은 색으로 채우지 않고 **투명**으로 둔다 — 배경은 adaptive-icon
 * 의 background 색이 깔린다.
 *
 * ── 배경색
 * ic_launcher_background 를 아이콘 배경과 같은 색으로 맞춘다. 흰색으로 두면
 * 어두운 아이콘 둘레에 흰 테가 생긴다.
 *
 * 실행: node scripts/make-icon.cjs
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'store', 'assets', 'app-icon-512.png');
const RES = path.join(root, 'android', 'app', 'src', 'main', 'res');

/**
 * 전경을 얼마나 줄여 넣을 것인가.
 *
 * 흔히 0.66을 쓰지만 **그건 과하다.** 원형 마스크가 확실히 살리는 것은 지름
 * 72%이고, 거기 걸리는 것은 그림의 폭이 아니라 **대각선**이다.
 *
 *   종이 상자 314x512 → 폭 61%, 대각선 91%
 *   0.66 → 폭 40%, 대각선 60%   안전하지만 아이콘이 작아 보인다
 *   0.75 → 폭 46%, 대각선 68%   ← 여기
 *   0.85 → 폭 52%, 대각선 77%   잘린다
 *
 * 원본이 이미 둘레에 여백을 두고 있어서 두 번 줄면 종이가 우표만 해진다.
 * 실제로 0.66으로 뽑아 원형 마스크를 씌워 보고 고쳤다.
 */
const SAFE = 0.75;

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

/** 아이콘 배경색 — 원본의 모서리에서 읽는다 */
async function backgroundColor() {
    const { data } = await sharp(SRC)
        .extract({ left: 2, top: 2, width: 8, height: 8 })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
}

(async () => {
    if (!fs.existsSync(SRC)) throw new Error(`원본이 없습니다: ${SRC}`);
    const meta = await sharp(SRC).metadata();
    if (meta.width !== 512 || meta.height !== 512) {
        throw new Error(`원본은 512x512 여야 합니다 (지금 ${meta.width}x${meta.height})`);
    }

    const bg = await backgroundColor();

    for (const [dpi, size] of Object.entries(DENSITIES)) {
        const dir = path.join(RES, `mipmap-${dpi}`);
        fs.mkdirSync(dir, { recursive: true });

        // 정사각 런처 아이콘 (안드로이드 7 이하) — 원본 그대로
        const square = await sharp(SRC).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
        fs.writeFileSync(path.join(dir, 'ic_launcher.png'), square);
        fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), square);

        /*
         * 적응형 전경 — 안전 영역 안으로 줄이고 둘레는 투명.
         * 전경 캔버스는 정사각 아이콘과 같은 크기로 둔다(안드로이드가 알아서 확대한다).
         */
        const inner = Math.round(size * SAFE);
        const pad = Math.round((size - inner) / 2);
        const fg = await sharp(SRC)
            .resize(inner, inner, { kernel: 'lanczos3' })
            .extend({
                top: pad,
                bottom: size - inner - pad,
                left: pad,
                right: size - inner - pad,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();
        fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fg);

        console.log(`  mipmap-${dpi.padEnd(8)} ${size}x${size}  (전경 안쪽 ${inner}px)`);
    }

    // 배경색 갱신
    const colorFile = path.join(RES, 'values', 'ic_launcher_background.xml');
    fs.writeFileSync(
        colorFile,
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${bg}</color>\n</resources>\n`,
    );
    console.log(`\n  배경색 → ${bg}  (${path.relative(root, colorFile)})`);

    /*
     * drawable 쪽 벡터는 Capacitor 기본값이다. 적응형 정의가 mipmap 의 png 전경을
     * 가리키도록 되어 있으므로 벡터가 남아 있어도 쓰이지 않지만, 헷갈리지 않게 지운다.
     */
    for (const stale of [
        'drawable-v24/ic_launcher_foreground.xml',
        'drawable/ic_launcher_background.xml',
    ]) {
        const p = path.join(RES, stale);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            console.log(`  기본 벡터 제거: ${stale}`);
        }
    }
})().catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
});
