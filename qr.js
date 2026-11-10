import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jsQR from 'jsqr';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readBarcodesFromImageFile } from 'zxing-wasm/reader';

// Pre-warm ZXing WebAssembly module on startup so real-time decoding takes ~50ms
readBarcodesFromImageFile(new Blob([new Uint8Array([0])]), { formats: ['QRCode'] }).catch(() => {});

/**
 * Decodes a QR code from an image Buffer in memory (~50ms).
 * 1. Primary: zxing-wasm (C++ ZXing compiled to WebAssembly with tryHarder + adaptive thresholding - reads angled/blue projector photos in ~50ms!)
 * 2. Fallback: jsQR (in-memory) & zbarimg
 */
export async function decodeQrFromBuffer(buffer) {
  // 1. Primary: ZXing-WASM (handles projector glare, perspective distortion, phone photos in ~50ms)
  try {
    const blob = new Blob([buffer]);
    const results = await readBarcodesFromImageFile(blob, {
      formats: ['QRCode'],
      tryHarder: true,
      tryRotate: true,
      tryDownscale: true,
      tryInvert: true,
    });
    if (results && results.length > 0 && results[0].text) {
      return results[0].text.trim();
    }
  } catch {
    // Fallback below
  }

  // 2. Secondary: Fast in-memory jsQR attempt (PNG or JPEG)
  try {
    let rawData = null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
      rawData = PNG.sync.read(buffer);
    } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      rawData = jpeg.decode(buffer, { useTArray: true });
    }
    if (rawData) {
      const code = jsQR(
        new Uint8ClampedArray(rawData.data),
        rawData.width,
        rawData.height
      );
      if (code && code.data) {
        return code.data.trim();
      }
    }
  } catch {}

  // 3. Tertiary fallback: system zbarimg
  const tmpFile = path.join(os.tmpdir(), `qr_${Date.now()}_${Math.random().toString(36).slice(2)}.img`);
  try {
    fs.writeFileSync(tmpFile, buffer);
    const res = spawnSync('zbarimg', ['--quiet', '--raw', tmpFile], {
      encoding: 'utf-8',
      timeout: 1500,
    });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim().split('\n')[0].trim();
    }
  } catch {
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
  }

  return null;
}
