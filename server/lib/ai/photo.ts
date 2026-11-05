import { AiError } from '@server/lib/ai';
import type { CompletionImage } from '@server/lib/ai/providers';
import logger from '@server/logger';
import type sharpType from 'sharp';

/*
 * Shrinks a photo before the model reads it. Claude bills by area (about one
 * token per 750 pixels), OpenAI by 512-pixel tiles, so each photo is turned
 * upright, trimmed of plain borders and scaled to the budget below, keeping
 * the cost about the same whatever is sent.
 */

/** About 1,000 tokens on Claude, and four tiles on OpenAI. */
export const PHOTO_PIXELS = 750_000;
/** Keeps a tall screenshot from staying long and thin. */
export const PHOTO_LONGEST_SIDE = 1600;
/** Trim borders only if at least this share of the picture remains. */
const MIN_KEPT_AFTER_TRIM = 0.2;
/**
 * Above any phone camera (48 MP fits). Checked from the header before
 * decoding, since a small file can claim huge dimensions and tie up the
 * server for seconds.
 */
export const PHOTO_MAX_INPUT_PIXELS = 50_000_000;
/**
 * Downscaled to this before trimming so trimming stays fast; twice the
 * longest side sent, so no detail is lost.
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
    // Upright, first frame only, and no metadata (location, camera) kept.
    // Raw pixels between steps, so nothing is encoded twice.
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
