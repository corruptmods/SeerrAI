import { AiError } from '@server/lib/ai';
import {
  PHOTO_LONGEST_SIDE,
  PHOTO_PIXELS,
  preparePhoto,
} from '@server/lib/ai/photo';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
