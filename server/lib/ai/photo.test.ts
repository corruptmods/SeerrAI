import { AiError } from '@server/lib/ai';
import {
  PHOTO_LONGEST_SIDE,
  PHOTO_PIXELS,
  preparePhoto,
} from '@server/lib/ai/photo';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

/*
 * A photo shrunk to what the model is paid to read, whatever size it came
 * in: the cost of a look stays about the same.
 */

const picture = async (
  width: number,
  height: number,
  options: { border?: number; orientation?: number } = {}
) => {
  const border = options.border ?? 0;
  let image = sharp({
    create: {
      width: width - border * 2,
      height: height - border * 2,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width - border * 2}" height="${height - border * 2}"><rect x="10%" y="10%" width="50%" height="30%" fill="#2040c0"/></svg>`
        ),
      },
    ])
    .extend({
      top: border,
      bottom: border,
      left: border,
      right: border,
      background: { r: 0, g: 0, b: 0 },
    });
  if (options.orientation) {
    image = image.withMetadata({ orientation: options.orientation });
  }
  return {
    type: 'image/jpeg' as const,
    data: (await image.jpeg().toBuffer()).toString('base64'),
  };
};

/**
 * A white PNG at one bit a pixel, written by hand: a few kilobytes to send
 * however many pixels it says it has.
 */
const blankPng = (width: number, height: number) => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bits a pixel
  header[9] = 0; // greyscale
  const row = Buffer.alloc(1 + Math.ceil(width / 8), 0xff);
  row[0] = 0; // no filter
  const rows = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) {
    row.copy(rows, y * row.length);
  }
  return {
    type: 'image/png' as const,
    data: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64'),
  };
};

const sizeOf = async (data: string) =>
  sharp(Buffer.from(data, 'base64')).metadata();

describe('a photo for the model', () => {
  it('is cut to the pixel budget, keeping its shape', async () => {
    const out = await preparePhoto(await picture(4032, 3024));
    const { width = 0, height = 0, format } = await sizeOf(out.data);
    assert.equal(format, 'jpeg');
    assert.ok(width * height <= PHOTO_PIXELS * 1.01, `${width}x${height}`);
    assert.ok(Math.abs(width / height - 4 / 3) < 0.01);
  });

  it('keeps a tall screenshot from becoming long and thin', async () => {
    const out = await preparePhoto(await picture(600, 4000));
    const { height = 0 } = await sizeOf(out.data);
    assert.ok(height <= PHOTO_LONGEST_SIDE);
  });

  it('leaves a small picture its size', async () => {
    const out = await preparePhoto(await picture(640, 480));
    const { width, height } = await sizeOf(out.data);
    assert.deepEqual([width, height], [640, 480]);
  });

  it('cuts away plain borders, which cost as much as the picture', async () => {
    const out = await preparePhoto(await picture(800, 800, { border: 150 }));
    const { width = 0, height = 0 } = await sizeOf(out.data);
    assert.ok(width <= 520 && height <= 520, `${width}x${height}`);
  });

  it('turns a phone photo the right way up, and drops what the camera wrote', async () => {
    // Stored sideways, with the camera saying to turn it.
    const out = await preparePhoto(await picture(400, 300, { orientation: 6 }));
    const meta = await sizeOf(out.data);
    assert.deepEqual([meta.width, meta.height], [300, 400]);
    assert.equal(meta.exif, undefined);
  });

  it('refuses a picture too large to open, without opening it', async () => {
    // 16000 × 16000: well under the 5 MB the app accepts, and 256 million
    // pixels, which took a server many seconds to read and cut borders from.
    const bomb = blankPng(16000, 16000);
    assert.ok(Buffer.from(bomb.data, 'base64').length < 100_000);
    const started = Date.now();
    await assert.rejects(
      preparePhoto(bomb),
      (e: AiError) =>
        e instanceof AiError && e.status === 400 && e.code === 'pictureTooBig'
    );
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });

  it('still reads a large picture within the limit', async () => {
    const out = await preparePhoto(blankPng(6000, 6000));
    const { width = 0, height = 0 } = await sizeOf(out.data);
    assert.ok(width <= PHOTO_LONGEST_SIDE && height <= PHOTO_LONGEST_SIDE);
  });

  it('refuses what is not a picture', async () => {
    await assert.rejects(
      preparePhoto({
        type: 'image/jpeg',
        data: Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3]).toString('base64'),
      }),
      (e: AiError) => e instanceof AiError && e.status === 400
    );
  });
});
