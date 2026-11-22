/**
 * Strictly lossless PNG re-encoder (Node built-ins only).
 *
 * Decodes the image to RGBA8, then tries every lossless representation
 * (palette at 1/2/4/8 bits, grayscale, gray+alpha, RGB, RGB+tRNS, RGBA) with a
 * set of scanline filters and deflate strategies, and keeps the smallest.
 *
 * - Every RGBA value is preserved exactly, including the colour stored under
 *   fully transparent pixels.
 * - Metadata chunks (pHYs, tEXt, tIME, bKGD, sRGB/gAMA, ...) are dropped. Colour
 *   chunks are kept only when they describe a non-sRGB colour space (iCCP,
 *   cHRM, cICP, or a gAMA other than 1/2.2 without sRGB), since dropping those
 *   would change how the image renders.
 * - The chosen output is decoded again and compared with the source pixels; if
 *   anything differs (or anything throws) the original bytes are returned.
 * - Non-PNG input, 16-bit and interlaced PNGs are returned unchanged.
 */
import { promisify } from 'util';
import * as zlib from 'zlib';

const deflateAsync = promisify(zlib.deflate) as (buf: Buffer, opts: zlib.ZlibOptions) => Promise<Buffer>;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR_CHUNKS = new Set(['sRGB', 'gAMA', 'cHRM', 'iCCP', 'cICP']);
const SRGB_GAMMA = 45455; // 1/2.2, what browsers assume for untagged PNGs

/** Filter ids: 0-4 are the fixed PNG filters, 5 is adaptive per-row (minimum sum of absolute differences). */
export type PngFilter = 0 | 1 | 2 | 3 | 4 | 5;

export interface PngOptimizeOptions {
  /** Scanline filters to try. Default: all six. */
  filters?: PngFilter[];
  /** zlib strategies to try. Default: DEFAULT, FILTERED, RLE, FIXED, HUFFMAN_ONLY. */
  strategies?: number[];
  /** Palette orderings to try when the image has <= 256 colours. Default: all three. */
  paletteOrders?: Array<'alpha-first' | 'freq' | 'sorted'>;
}

/** Exhaustive search; for one-off/batch uploads. */
export const PNG_OPTIMIZE_MAX: Required<PngOptimizeOptions> = {
  filters: [0, 1, 2, 3, 4, 5],
  strategies: [
    zlib.constants.Z_DEFAULT_STRATEGY,
    zlib.constants.Z_FILTERED,
    zlib.constants.Z_RLE,
    zlib.constants.Z_FIXED,
    zlib.constants.Z_HUFFMAN_ONLY,
  ],
  paletteOrders: ['alpha-first', 'freq', 'sorted'],
};

/** Small search tuned on the social cards; for request-time encoding. */
export const PNG_OPTIMIZE_FAST: Required<PngOptimizeOptions> = {
  filters: [0, 2, 5],
  strategies: [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED],
  paletteOrders: ['alpha-first'],
};

export interface PngOptimizeResult {
  /** The bytes to store: optimized PNG, or the original if nothing smaller was found. */
  buffer: Buffer;
  /** True when `buffer` is a new, smaller, pixel-verified PNG. */
  optimized: boolean;
  originalSize: number;
  size: number;
  /** Which representation won, or why the original was kept. */
  method: string;
}

interface Chunk {
  type: string;
  data: Buffer;
}

interface Decoded {
  width: number;
  height: number;
  /** RGBA8, row-major. */
  px: Buffer;
}

interface Candidate {
  label: string;
  colorType: number;
  bitDepth: number;
  plte?: Buffer;
  trns?: Buffer;
  /** Unfiltered scanlines, each `stride` bytes. */
  raw: Buffer;
  stride: number;
  bpp: number;
}

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
}

export async function optimizePng(input: Buffer, options: PngOptimizeOptions = {}): Promise<PngOptimizeResult> {
  const keep = (method: string): PngOptimizeResult => ({
    buffer: input,
    optimized: false,
    originalSize: input.length,
    size: input.length,
    method,
  });

  if (!isPng(input)) return keep('not-png');

  const opts = { ...PNG_OPTIMIZE_MAX, ...options };

  try {
    const chunks = parseChunks(input);
    const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
    if (!ihdr) return keep('no-ihdr');
    if (ihdr[8] === 16 || ihdr[12] !== 0) return keep('unsupported-16bit-or-interlaced');

    const source = decode(chunks);
    const kept = colourChunksToKeep(chunks);

    // Passthrough: original compressed pixel data with metadata stripped.
    let best = {
      png: assemble(ihdr, kept, chunk(chunks, 'PLTE'), chunk(chunks, 'tRNS'), idatOf(chunks)),
      method: 'passthrough-stripped',
    };

    for (const cand of candidates(source, opts.paletteOrders)) {
      const streams = filterStreams(cand.raw, cand.stride, cand.bpp, source.height, opts.filters);
      for (const [filterLabel, stream] of streams) {
        const compressed = await Promise.all(
          opts.strategies.map((strategy) => deflateAsync(stream, { level: 9, memLevel: 9, strategy })),
        );
        compressed.forEach((z, i) => {
          const header = ihdrBytes(source.width, source.height, cand.bitDepth, cand.colorType);
          const png = assemble(header, kept, cand.plte, cand.trns, z);
          if (png.length < best.png.length) {
            best = { png, method: `${cand.label}/${filterLabel}/s${opts.strategies[i]}` };
          }
        });
      }
    }

    if (best.png.length >= input.length) return keep('kept-original');

    // Verify: the new file must decode to exactly the same pixels.
    const check = decode(parseChunks(best.png));
    if (check.width !== source.width || check.height !== source.height || !check.px.equals(source.px)) {
      return keep('verify-failed');
    }

    return {
      buffer: best.png,
      optimized: true,
      originalSize: input.length,
      size: best.png.length,
      method: best.method,
    };
  } catch (error) {
    return keep(`error:${(error as Error).message}`);
  }
}

// ----------------------------------------------------------------------------- parse / decode

function parseChunks(data: Buffer): Chunk[] {
  const out: Chunk[] = [];
  let pos = 8;
  while (pos + 8 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + length > data.length) throw new Error('truncated chunk');
    out.push({ type, data: data.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

function chunk(chunks: Chunk[], type: string): Buffer | undefined {
  return chunks.find((c) => c.type === type)?.data;
}

function idatOf(chunks: Chunk[]): Buffer {
  return Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw: Buffer, stride: number, height: number, bpp: number): Buffer {
  if (raw.length < (stride + 1) * height) throw new Error('short image data');
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = y > 0 ? out[prev + i] : 0;
      const ul = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + left; break;
        case 2: v = x + up; break;
        case 3: v = x + ((left + up) >> 1); break;
        case 4: v = x + paeth(left, up, ul); break;
        default: throw new Error('bad filter type');
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

function sample(row: Buffer, rowStart: number, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[rowStart + index];
  const bit = index * bitDepth;
  return (row[rowStart + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
}

function decode(chunks: Chunk[]): Decoded {
  const ihdr = chunk(chunks, 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth === 16 || ihdr[12] !== 0) throw new Error('unsupported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error('bad colour type');

  const plte = chunk(chunks, 'PLTE');
  const trns = chunk(chunks, 'tRNS');
  const stride = Math.ceil((width * bitDepth * channels) / 8);
  const bpp = Math.max(1, (bitDepth * channels) >> 3);
  const rows = unfilter(zlib.inflateSync(idatOf(chunks)), stride, height, bpp);

  const px = Buffer.alloc(width * height * 4);
  const maxv = (1 << bitDepth) - 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const rs = y * stride;
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number, a = 255;
      switch (colorType) {
        case 6:
          r = rows[rs + 4 * x]; g = rows[rs + 4 * x + 1]; b = rows[rs + 4 * x + 2]; a = rows[rs + 4 * x + 3];
          break;
        case 2:
          r = rows[rs + 3 * x]; g = rows[rs + 3 * x + 1]; b = rows[rs + 3 * x + 2];
          if (trns && trns.length >= 6 && r === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && b === trns.readUInt16BE(4)) a = 0;
          break;
        case 3: {
          const i = sample(rows, rs, x, bitDepth);
          if (!plte || 3 * i + 2 >= plte.length) throw new Error('palette index out of range');
          r = plte[3 * i]; g = plte[3 * i + 1]; b = plte[3 * i + 2];
          if (trns && i < trns.length) a = trns[i];
          break;
        }
        case 0: {
          const v = sample(rows, rs, x, bitDepth);
          r = g = b = Math.floor((v * 255) / maxv);
          if (trns && trns.length >= 2 && v === trns.readUInt16BE(0)) a = 0;
          break;
        }
        default: // 4: gray + alpha, always 8-bit here
          r = g = b = rows[rs + 2 * x];
          a = rows[rs + 2 * x + 1];
      }
      px[o++] = r; px[o++] = g; px[o++] = b; px[o++] = a;
    }
  }
  return { width, height, px };
}

function colourChunksToKeep(chunks: Chunk[]): Chunk[] {
  const present = new Map(chunks.filter((c) => COLOUR_CHUNKS.has(c.type)).map((c) => [c.type, c.data]));
  const gama = present.get('gAMA');
  const nonSrgb =
    present.has('iCCP') || present.has('cHRM') || present.has('cICP') ||
    (gama !== undefined && gama.length === 4 && gama.readUInt32BE(0) !== SRGB_GAMMA && !present.has('sRGB'));
  return nonSrgb ? chunks.filter((c) => COLOUR_CHUNKS.has(c.type)) : [];
}

// ----------------------------------------------------------------------------- encode

function packRow(values: Uint8Array, bitDepth: number): Buffer {
  if (bitDepth === 8) return Buffer.from(values);
  const out = Buffer.alloc(Math.ceil((values.length * bitDepth) / 8));
  for (let i = 0; i < values.length; i++) {
    const bit = i * bitDepth;
    out[bit >> 3] |= values[i] << (8 - bitDepth - (bit & 7));
  }
  return out;
}

function* candidates(img: Decoded, paletteOrders: PngOptimizeOptions['paletteOrders']): Generator<Candidate> {
  const { width: w, height: h, px } = img;
  const n = w * h;
  const pixels = new Uint32Array(n);
  for (let i = 0; i < n; i++) pixels[i] = px.readUInt32BE(4 * i); // 0xRRGGBBAA

  const counts = new Map<number, number>();
  let allOpaque = true;
  let isGray = true;
  for (let i = 0; i < n; i++) {
    const c = pixels[i];
    counts.set(c, (counts.get(c) ?? 0) + 1);
    const a = c & 0xff;
    if (a !== 255) allOpaque = false;
    const r = c >>> 24, g = (c >>> 16) & 0xff, b = (c >>> 8) & 0xff;
    if (r !== g || g !== b) isGray = false;
  }
  const colours = [...counts.keys()];
  const alpha = (c: number) => c & 0xff;
  const transparent = colours.filter((c) => alpha(c) !== 255);

  // Palette
  if (colours.length <= 256) {
    const opaqueLast = (c: number) => (alpha(c) === 255 ? 1 : 0);
    const orders: Record<string, (a: number, b: number) => number> = {
      'alpha-first': (a, b) => opaqueLast(a) - opaqueLast(b) || counts.get(b)! - counts.get(a)! || a - b,
      freq: (a, b) => counts.get(b)! - counts.get(a)! || a - b,
      sorted: (a, b) => opaqueLast(a) - opaqueLast(b) || a - b,
    };
    const k = colours.length;
    const bitDepth = k <= 2 ? 1 : k <= 4 ? 2 : k <= 16 ? 4 : 8;
    const stride = Math.ceil((w * bitDepth) / 8);
    for (const name of paletteOrders ?? []) {
      const order = [...colours].sort(orders[name]);
      const index = new Map(order.map((c, i) => [c, i]));
      const plte = Buffer.alloc(order.length * 3);
      order.forEach((c, i) => {
        plte[3 * i] = c >>> 24; plte[3 * i + 1] = (c >>> 16) & 0xff; plte[3 * i + 2] = (c >>> 8) & 0xff;
      });
      let lastT = -1;
      order.forEach((c, i) => { if (alpha(c) !== 255) lastT = i; });
      const trns = lastT >= 0 ? Buffer.from(order.slice(0, lastT + 1).map(alpha)) : undefined;
      const raw = Buffer.alloc(stride * h);
      const rowVals = new Uint8Array(w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) rowVals[x] = index.get(pixels[y * w + x])!;
        packRow(rowVals, bitDepth).copy(raw, y * stride);
      }
      yield { label: `pal-${name}`, colorType: 3, bitDepth, plte, trns, raw, stride, bpp: 1 };
    }
  }

  // Grayscale
  if (isGray) {
    const opaqueGrays = new Set(colours.filter((c) => alpha(c) === 255).map((c) => c >>> 24));
    const trOk =
      !allOpaque && transparent.length === 1 && alpha(transparent[0]) === 0 &&
      !opaqueGrays.has(transparent[0] >>> 24);
    if (allOpaque || trOk) {
      const grays = new Set(colours.map((c) => c >>> 24));
      let bitDepth = 8;
      for (const bd of [1, 2, 4, 8]) {
        const scale = 255 / ((1 << bd) - 1);
        if ([...grays].every((g) => g % scale === 0)) { bitDepth = bd; break; }
      }
      const scale = 255 / ((1 << bitDepth) - 1);
      const stride = Math.ceil((w * bitDepth) / 8);
      const raw = Buffer.alloc(stride * h);
      const rowVals = new Uint8Array(w);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) rowVals[x] = (pixels[y * w + x] >>> 24) / scale;
        packRow(rowVals, bitDepth).copy(raw, y * stride);
      }
      let trns: Buffer | undefined;
      if (trOk) {
        trns = Buffer.alloc(2);
        trns.writeUInt16BE((transparent[0] >>> 24) / scale);
      }
      yield { label: `gray${bitDepth}`, colorType: 0, bitDepth, trns, raw, stride, bpp: 1 };
    }
    const raw = Buffer.alloc(w * h * 2);
    for (let i = 0; i < n; i++) { raw[2 * i] = px[4 * i]; raw[2 * i + 1] = px[4 * i + 3]; }
    yield { label: 'graya', colorType: 4, bitDepth: 8, raw, stride: w * 2, bpp: 2 };
  }

  // RGB / RGB+tRNS
  const rgbTrOk =
    transparent.length === 1 && alpha(transparent[0]) === 0 &&
    !counts.has(((transparent[0] & 0xffffff00) | 0xff) >>> 0);
  if (allOpaque || rgbTrOk) {
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < n; i++) {
      raw[3 * i] = px[4 * i]; raw[3 * i + 1] = px[4 * i + 1]; raw[3 * i + 2] = px[4 * i + 2];
    }
    let trns: Buffer | undefined;
    if (rgbTrOk) {
      const t = transparent[0];
      trns = Buffer.alloc(6);
      trns.writeUInt16BE(t >>> 24, 0); trns.writeUInt16BE((t >>> 16) & 0xff, 2); trns.writeUInt16BE((t >>> 8) & 0xff, 4);
    }
    yield { label: trns ? 'rgb-trns' : 'rgb', colorType: 2, bitDepth: 8, trns, raw, stride: w * 3, bpp: 3 };
  }

  // RGBA is always possible.
  yield { label: 'rgba', colorType: 6, bitDepth: 8, raw: Buffer.from(px), stride: w * 4, bpp: 4 };
}

function filterRow(f: number, raw: Buffer, rowStart: number, stride: number, bpp: number, first: boolean, out: Buffer, outStart: number) {
  out[outStart] = f;
  for (let i = 0; i < stride; i++) {
    const x = raw[rowStart + i];
    const left = i >= bpp ? raw[rowStart + i - bpp] : 0;
    const up = first ? 0 : raw[rowStart - stride + i];
    const ul = first || i < bpp ? 0 : raw[rowStart - stride + i - bpp];
    let p: number;
    switch (f) {
      case 0: p = 0; break;
      case 1: p = left; break;
      case 2: p = up; break;
      case 3: p = (left + up) >> 1; break;
      default: p = paeth(left, up, ul);
    }
    out[outStart + 1 + i] = (x - p) & 0xff;
  }
}

function filterStreams(raw: Buffer, stride: number, bpp: number, height: number, filters: PngFilter[]): Array<[string, Buffer]> {
  const rowLen = stride + 1;
  const fixed: Buffer[] = [];
  const needAll = filters.includes(5);
  for (let f = 0; f <= 4; f++) {
    if (!needAll && !filters.includes(f as PngFilter)) { fixed.push(Buffer.alloc(0)); continue; }
    const out = Buffer.alloc(rowLen * height);
    for (let y = 0; y < height; y++) filterRow(f, raw, y * stride, stride, bpp, y === 0, out, y * rowLen);
    fixed.push(out);
  }
  const streams: Array<[string, Buffer]> = [];
  for (const f of filters) {
    if (f <= 4) { streams.push([`f${f}`, fixed[f]]); continue; }
    const adaptive = Buffer.alloc(rowLen * height);
    for (let y = 0; y < height; y++) {
      let bestF = 0;
      let bestScore = Infinity;
      for (let cf = 0; cf <= 4; cf++) {
        let score = 0;
        const base = y * rowLen + 1;
        for (let i = 0; i < stride; i++) {
          const v = fixed[cf][base + i];
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) { bestScore = score; bestF = cf; }
      }
      fixed[bestF].copy(adaptive, y * rowLen, y * rowLen, (y + 1) * rowLen);
    }
    streams.push(['msad', adaptive]);
  }
  return streams;
}

function ihdrBytes(width: number, height: number, bitDepth: number, colorType: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = bitDepth;
  b[9] = colorType;
  return b; // compression, filter method, interlace all 0
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function assemble(ihdr: Buffer, kept: Chunk[], plte: Buffer | undefined, trns: Buffer | undefined, idat: Buffer): Buffer {
  const parts = [PNG_SIG, encodeChunk('IHDR', ihdr)];
  for (const c of kept) parts.push(encodeChunk(c.type, c.data));
  if (plte) parts.push(encodeChunk('PLTE', plte));
  if (trns) parts.push(encodeChunk('tRNS', trns));
  parts.push(encodeChunk('IDAT', idat), encodeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
