//! 그림 — 문서가 가리키는 파일의 크기를 머리글만 보고 알아내고(배치용), 그릴 때 WIC 로 읽는다.
//!
//! 배치는 그림의 크기가 먼저 있어야 높이를 정한다. 파일 전체를 읽어 디코딩하면 그만큼 첫 화면이 늦으므로, 크기는 파일 머리글(PNG · JPEG · GIF · BMP ·
//! WebP)에서 바로 읽는다. 디코딩은 화면에 들어올 때 따로 스레드에서 한다(`decode`).

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::links::resolve_doc_link;
use crate::text::{has_ext, IMAGE_EXTENSIONS};

/// 머리글을 읽을 바이트 수. JPEG 은 SOF 앞에 EXIF · 미리보기가 길게 올 수 있다.
const HEAD_BYTES: usize = 160 * 1024;

fn be16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32)
}
fn be32(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *b.get(i)?,
        *b.get(i + 1)?,
        *b.get(i + 2)?,
        *b.get(i + 3)?,
    ]))
}
fn le16(b: &[u8], i: usize) -> Option<u32> {
    Some(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?]) as u32)
}
fn le24(b: &[u8], i: usize) -> Option<u32> {
    Some(*b.get(i)? as u32 | (*b.get(i + 1)? as u32) << 8 | (*b.get(i + 2)? as u32) << 16)
}
fn le32(b: &[u8], i: usize) -> Option<u32> {
    Some(le16(b, i)? | le16(b, i + 2)? << 16)
}

/// 파일 머리글에서 그림의 가로 · 세로(px). 모르는 꼴이면 None.
pub fn sniff(b: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        (be32(b, 16)?, be32(b, 20)?)
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        (le16(b, 6)?, le16(b, 8)?)
    } else if b.starts_with(b"BM") {
        let w = le32(b, 18)? as i32;
        let h = le32(b, 22)? as i32;
        (w.unsigned_abs(), h.unsigned_abs())
    } else if b.starts_with(&[0xff, 0xd8]) {
        jpeg_size(b)?
    } else if b.len() >= 30 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8 " => (le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff),
            b"VP8L" => {
                let bits = le32(b, 21)?;
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            b"VP8X" => (le24(b, 24)? + 1, le24(b, 27)? + 1),
            _ => return None,
        }
    } else {
        return None;
    };
    if w == 0 || h == 0 || w > 65_535 * 4 || h > 65_535 * 4 {
        return None;
    }
    Some((w, h))
}

fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xff {
            i += 1;
            continue;
        }
        let m = b[i + 1];
        // 채움 바이트 · 길이 없는 표지
        if m == 0xff {
            i += 1;
            continue;
        }
        if m == 0xd8 || m == 0x01 || (0xd0..=0xd7).contains(&m) {
            i += 2;
            continue;
        }
        let len = be16(b, i + 2)? as usize;
        // SOF0..SOF15 (DHT · JPG · DAC 제외)
        if (0xc0..=0xcf).contains(&m) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
            return Some((be16(b, i + 7)?, be16(b, i + 5)?));
        }
        i += 2 + len;
    }
    None
}

/// 파일의 그림 크기. 못 읽으면 None.
pub fn sniff_file(path: &Path) -> Option<(u32, u32)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => return None,
        }
    }
    sniff(&buf[..n])
}

/// 문서 안의 상대 그림 주소 → 열어도 되는 파일 경로. 그림 확장자만 내준다. 네트워크 경로(UNC)는 문서와 같은 공유일 때만 — links.rs 가 걸러 준다.
pub fn resolve_local(doc_dir: &Path, src: &str) -> Option<PathBuf> {
    // 스킴이 있는 것(http · data …)과 루트 기준(/x.png)은 문서 폴더의 파일이 아니다
    if src.starts_with('/') || src.starts_with('\\') {
        return None;
    }
    let p = resolve_doc_link(doc_dir, src)?;
    if !has_ext(&p, &IMAGE_EXTENSIONS) {
        return None;
    }
    Some(p)
}

/// 읽은 그림(미리 곱한 알파의 BGRA)
pub struct Decoded {
    pub w: u32,
    pub h: u32,
    pub bgra: Vec<u8>,
}

/// WIC 로 그림을 읽는다(PNG · JPEG · GIF 첫 프레임 · BMP · ICO · TIFF · WebP(코덱이 있으면)). max_w 보다 넓으면 그 너비로 줄인다.
/// 이 스레드에서 COM 을 쓴다 — 그림마다 따로 스레드에서 부른다.
pub fn decode(path: &Path, max_w: u32) -> Option<Decoded> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let wide: Vec<u16> = path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(wide.as_ptr()),
                None,
                windows::Win32::Foundation::GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .ok()?;
        let frame = decoder.GetFrame(0).ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        frame.GetSize(&mut w, &mut h).ok()?;
        if w == 0 || h == 0 || (w as u64) * (h as u64) > 120_000_000 {
            return None;
        }
        let conv = factory.CreateFormatConverter().ok()?;
        conv.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppPBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )
        .ok()?;
        let (mut ow, mut oh) = (w, h);
        let src: IWICBitmapSource = if w > max_w.max(64) {
            ow = max_w.max(64);
            oh = ((h as u64 * ow as u64) / w as u64).max(1) as u32;
            let scaler = factory.CreateBitmapScaler().ok()?;
            scaler
                .Initialize(&conv, ow, oh, WICBitmapInterpolationModeHighQualityCubic)
                .ok()?;
            windows::core::Interface::cast(&scaler).ok()?
        } else {
            windows::core::Interface::cast(&conv).ok()?
        };
        let stride = ow * 4;
        let mut buf = vec![0u8; (stride * oh) as usize];
        src.CopyPixels(std::ptr::null(), stride, &mut buf).ok()?;
        Some(Decoded {
            w: ow,
            h: oh,
            bgra: buf,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_gif_bmp_sizes() {
        let mut png = vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        png.extend_from_slice(&300u32.to_be_bytes());
        png.extend_from_slice(&200u32.to_be_bytes());
        assert_eq!(sniff(&png), Some((300, 200)));

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&64u16.to_le_bytes());
        gif.extend_from_slice(&48u16.to_le_bytes());
        assert_eq!(sniff(&gif), Some((64, 48)));

        let mut bmp = vec![b'B', b'M'];
        bmp.resize(18, 0);
        bmp.extend_from_slice(&100i32.to_le_bytes());
        bmp.extend_from_slice(&(-50i32).to_le_bytes()); // 위에서 아래로 저장된 BMP
        assert_eq!(sniff(&bmp), Some((100, 50)));
    }

    #[test]
    fn jpeg_size_skips_other_segments() {
        // SOI, APP0(길이 16), SOF0(높이 120 · 너비 160)
        let mut j = vec![0xff, 0xd8, 0xff, 0xe0, 0, 16];
        j.extend_from_slice(&[0u8; 14]);
        j.extend_from_slice(&[0xff, 0xc0, 0, 17, 8, 0, 120, 0, 160, 3]);
        assert_eq!(sniff(&j), Some((160, 120)));
    }

    #[test]
    fn webp_variants() {
        let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0\0\0\0\0\0\0\0\0\x9d\x01\x2a".to_vec();
        // 26: 가로 · 28: 세로 (little endian, 14비트)
        lossy.truncate(26);
        lossy.extend_from_slice(&321u16.to_le_bytes());
        lossy.extend_from_slice(&123u16.to_le_bytes());
        assert_eq!(sniff(&lossy), Some((321, 123)));

        let mut ext = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        ext.extend_from_slice(&[0x2f, 0x01, 0x00]); // 가로-1 = 303
        ext.extend_from_slice(&[0x63, 0x00, 0x00]); // 세로-1 = 99
        assert_eq!(sniff(&ext), Some((304, 100)));
    }

    #[test]
    fn garbage_is_not_an_image() {
        assert_eq!(
            sniff(b"hello world, this is not an image at all......"),
            None
        );
        assert_eq!(sniff(&[]), None);
        assert_eq!(sniff(&[0xff, 0xd8, 0xff]), None);
    }

    #[test]
    fn local_sources_resolve_inside_the_document_folder() {
        let dir = Path::new("C:\\docs\\notes");
        assert_eq!(
            resolve_local(dir, "img/a.png").unwrap(),
            Path::new("C:\\docs\\notes\\img\\a.png")
        );
        assert!(resolve_local(dir, "a.exe").is_none());
        assert!(resolve_local(dir, "https://x/a.png").is_none());
        assert!(resolve_local(dir, "//host/a.png").is_none());
        assert!(resolve_local(dir, "/a.png").is_none());
    }
}
