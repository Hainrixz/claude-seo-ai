// Intrinsic image dimensions sniffed from the first bytes of a file. Pure, zero-dependency,
// no I/O: the caller supplies a Buffer/Uint8Array (usually the head of an HTTP response).
//
// Supported containers: PNG (incl. APNG, whose IHDR is identical), JPEG (first SOFn frame),
// GIF87a/GIF89a (logical screen descriptor) and the three WebP chunk flavours (VP8 lossy,
// VP8L lossless, VP8X extended). Anything else returns { format: null } with a reason —
// we never guess a size we did not read out of the bytes.
//
//   import { imageSize, sniffFormat } from './lib/imgsize.mjs';
//   imageSize(buf)  // -> { format: 'png', width: 1200, height: 630, bytes: 4096, error: null }
//
// Used by scripts/checks/social.mjs to state an og:image's real pixel size in evidence.

/** Bytes needed before a format can be decided; JPEG may need to walk further into the file. */
export const MIN_HEADER_BYTES = 32;

/** Minimum pixel size Twitter/X and Facebook document for a large summary card. */
export const OG_IMAGE_MIN = Object.freeze({ width: 200, height: 200 });

const toBuf = (b) => (Buffer.isBuffer(b) ? b : b && (ArrayBuffer.isView(b) || b instanceof ArrayBuffer) ? Buffer.from(b.buffer || b, b.byteOffset || 0, b.byteLength) : null);

const ascii = (buf, from, len) => buf.slice(from, from + len).toString('latin1');

/** Container name from the magic bytes alone ('png'|'jpeg'|'gif'|'webp'|null). */
export function sniffFormat(input) {
  const buf = toBuf(input);
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(buf, 1, 3) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length >= 6 && (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a')) return 'gif';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';
  return null;
}

function pngSize(buf) {
  // IHDR is always the first chunk: 8 signature + 4 length + 4 type, then width/height big-endian.
  if (buf.length < 24 || ascii(buf, 12, 4) !== 'IHDR') return { error: 'png header truncated' };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10) return { error: 'gif header truncated' };
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

// Markers that carry no payload (RSTn, SOI, EOI, TEM) and the SOFn markers that are not frames.
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);
const NOT_A_FRAME = new Set([0xc4, 0xc8, 0xcc]); // DHT, JPG (reserved), DAC

function jpegSize(buf) {
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; } // resync past fill bytes / entropy data
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) { i++; marker = buf[i + 1]; }
    i += 2;
    if (STANDALONE.has(marker)) continue;
    if (i + 1 >= buf.length) break;
    const len = buf.readUInt16BE(i);
    if (len < 2) return { error: 'jpeg segment length invalid' };
    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      if (i + 7 >= buf.length) return { error: 'jpeg frame header truncated' };
      return { width: buf.readUInt16BE(i + 5), height: buf.readUInt16BE(i + 3) };
    }
    i += len;
  }
  return { error: 'no jpeg frame header (SOFn) in the bytes provided' };
}

function webpSize(buf) {
  if (buf.length < 16) return { error: 'webp header truncated' };
  const chunk = ascii(buf, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code 0x9d 0x01 0x2a, then 14-bit width/height.
    if (buf.length < 30) return { error: 'webp VP8 frame truncated' };
    if (!(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return { error: 'webp VP8 sync code missing' };
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf.length < 25) return { error: 'webp VP8L frame truncated' };
    if (buf[20] !== 0x2f) return { error: 'webp VP8L signature missing' };
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    if (buf.length < 30) return { error: 'webp VP8X frame truncated' };
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return { error: 'unknown webp chunk "' + chunk + '"' };
}

/**
 * Read the intrinsic pixel size out of an image's leading bytes.
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @returns {{format: string|null, width: number|null, height: number|null, bytes: number, error: string|null}}
 */
export function imageSize(input) {
  const buf = toBuf(input);
  const bytes = buf ? buf.length : 0;
  const out = { format: null, width: null, height: null, bytes, error: null };
  if (!buf || !buf.length) { out.error = 'no bytes'; return out; }
  const format = sniffFormat(buf);
  if (!format) { out.error = 'not a PNG, JPEG, GIF or WebP file'; return out; }
  out.format = format;
  const r = format === 'png' ? pngSize(buf) : format === 'gif' ? gifSize(buf) : format === 'jpeg' ? jpegSize(buf) : webpSize(buf);
  if (r.error) { out.error = r.error; return out; }
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) {
    out.error = 'decoded a non-positive size';
    return out;
  }
  out.width = r.width;
  out.height = r.height;
  return out;
}
