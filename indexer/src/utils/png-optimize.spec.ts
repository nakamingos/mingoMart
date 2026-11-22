import { createCanvas, loadImage } from 'canvas';

import { isPng, optimizePng, PNG_OPTIMIZE_FAST, PNG_OPTIMIZE_MAX } from './png-optimize';

/** Decode with node-canvas (independent of the module's own decoder). Opaque images only. */
async function pixels(png: Buffer): Promise<Buffer> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return Buffer.from(ctx.getImageData(0, 0, img.width, img.height).data);
}

function chunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    types.push(png.toString('latin1', pos + 4, pos + 8));
    pos += 12 + len;
  }
  return types;
}

/** Insert a tEXt chunk after IHDR (CRC is not checked by the optimizer's parser). */
function withTextChunk(png: Buffer): Buffer {
  const body = Buffer.from('Comment\0hello world');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write('tEXt', 4, 'latin1');
  const crc = Buffer.alloc(4); // left as zero; the optimizer doesn't verify CRCs
  return Buffer.concat([png.subarray(0, 33), head, body, crc, png.subarray(33)]);
}

function drawCard(colours: number): Buffer {
  const canvas = createCanvas(240, 126);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff03b4';
  ctx.fillRect(0, 0, 240, 126);
  for (let i = 0; i < colours; i++) {
    ctx.fillStyle = `rgb(${(i * 37) % 256}, ${(i * 91) % 256}, ${(i * 13) % 256})`;
    ctx.fillRect((i * 7) % 230, (i * 11) % 116, 10, 10);
  }
  return canvas.toBuffer('image/png');
}

describe('optimizePng', () => {
  it.each([
    ['palette-sized image', 40],
    ['many-colour image', 2000],
  ])('re-encodes a %s smaller and pixel-identical', async (_label, colours) => {
    const input = drawCard(colours);
    for (const opts of [PNG_OPTIMIZE_FAST, PNG_OPTIMIZE_MAX]) {
      const result = await optimizePng(input, opts);
      expect(result.optimized).toBe(true);
      expect(result.size).toBeLessThan(input.length);
      expect(isPng(result.buffer)).toBe(true);
      expect((await pixels(result.buffer)).equals(await pixels(input))).toBe(true);
    }
  });

  it('strips metadata chunks', async () => {
    const clean = drawCard(40);
    const input = withTextChunk(clean);
    expect(chunkTypes(input)).toContain('tEXt');
    const result = await optimizePng(input, PNG_OPTIMIZE_FAST);
    expect(result.optimized).toBe(true);
    expect(chunkTypes(result.buffer)).not.toContain('tEXt');
    expect((await pixels(result.buffer)).equals(await pixels(clean))).toBe(true);
  });

  it('passes non-PNG input through unchanged', async () => {
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    const result = await optimizePng(gif);
    expect(result.optimized).toBe(false);
    expect(result.buffer).toBe(gif);
    expect(result.method).toBe('not-png');
  });

  it('returns the original for corrupt PNG data', async () => {
    const broken = drawCard(5).subarray(0, 60);
    const result = await optimizePng(broken);
    expect(result.optimized).toBe(false);
    expect(result.buffer).toBe(broken);
  });
});
