import { AiError } from '@server/lib/ai';
import type { CompletionImage } from '@server/lib/ai/providers';
import logger from '@server/logger';
import type sharpType from 'sharp';

/*
 * A photo made as cheap to read as it can be before the model sees it. Both
 * APIs bill a picture by its size: Claude by its area (about one token per
 * 750 pixels), OpenAI by the 512-pixel tiles it covers. A poster, a cover or
 * a message stays readable well below what a phone takes, so every photo is
 * turned the right way up, cut free of plain borders (letterboxing, a
 * screenshot's empty margins), and scaled to fit the budget below. Whatever
 * the app or another caller sends, the cost stays about the same.
 */

/** About 1,000 tokens on Claude, and four tiles on OpenAI. */
export const PHOTO_PIXELS = 750_000;
/** So a tall screenshot is not left long and thin. */
export const PHOTO_LONGEST_SIDE = 1600;
/** Borders are cut only when what is left is at least this share of it. */
const MIN_KEPT_AFTER_TRIM = 0.2;
/**
 * Larger than any phone camera takes (a 48-megapixel photo fits), and
 * checked from the file's header before anything is decoded. A small file
 * can claim far more pixels than it has bytes, and reading one of those
 * took many seconds of the server's time.
 */
export const PHOTO_MAX_INPUT_PIXELS = 50_000_000;
/**
 * A picture is brought down to this before its borders are looked for, so
 * cutting them is quick whatever size it came in; still twice the longest
 * side sent, so nothing is lost to it.
 */
const WORKING_SIDE = PHOTO_LONGEST_SIDE * 2;

type Sharp = typeof sharpType;
let sharpModule: Promise<Sharp | null> | undefined;

const loadSharp = () =>
  (sharpModule ??= import('sharp')
    .then((module) => (module.default ?? module) as Sharp)
    .catch((e) => {
      logger.warn('Photos cannot be resized here; sending them as they come', {
        label: 'AI',
        errorMessage: e.message,
      });
      return null;
    }));

export const preparePhoto = async (
  image: CompletionImage
): Promise<CompletionImage> => {
  const sharp = await loadSharp();
  if (!sharp) {
    return image;
  }
  try {
    // Upright as taken, first frame of an animation, and nothing else of
    // the original: its location and camera details stay behind. Kept as
    // plain pixels between the steps, so nothing is encoded twice.
    const upright = await sharp(Buffer.from(image.data, 'base64'), {
      failOn: 'error',
      limitInputPixels: PHOTO_MAX_INPUT_PIXELS,
    })
      .rotate()
      .resize(WORKING_SIDE, WORKING_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let source = upright.data;
    let { width, height, channels } = upright.info;
    const pixels = () => ({ raw: { width, height, channels } });

    const trimmed = await sharp(source, pixels())
      .trim({ threshold: 12 })
      .raw()
      .toBuffer({ resolveWithObject: true })
      .catch(() => null);
    if (
      trimmed &&
      trimmed.info.width * trimmed.info.height >=
        MIN_KEPT_AFTER_TRIM * width * height
    ) {
      source = trimmed.data;
      ({ width, height, channels } = trimmed.info);
    }

    const scale = Math.min(
      1,
      Math.sqrt(PHOTO_PIXELS / (width * height)),
      PHOTO_LONGEST_SIDE / Math.max(width, height)
    );
    const out = await sharp(source, pixels())
      .resize(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale))
      )
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { type: 'image/jpeg', data: out.toString('base64') };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.debug('A photo sent to AI Search could not be read', {
      label: 'AI',
      errorMessage,
    });
    if (/pixel limit/i.test(errorMessage)) {
      throw new AiError('That picture is too big.', 400, 'pictureTooBig');
    }
    throw new AiError('That picture could not be read.', 400, 'picture');
  }
};
