/*
 * Shrinks a photo to a JPEG capped on its longest side: a few hundred KB, with
 * location and camera metadata stripped. The server shrinks it further for
 * the model, so this only needs to stay legible.
 */

const LONGEST_SIDE = 1600;
/** Thumbnail kept in the conversation beside the question. */
const THUMBNAIL_SIDE = 240;

export interface ShrunkPhoto {
  type: 'image/jpeg';
  /** JPEG bytes as base64. */
  data: string;
  /** Thumbnail data URL for the conversation. */
  thumbnail: string;
}

export class PhotoUnreadable extends Error {}

const load = (file: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new PhotoUnreadable());
    };
    image.src = url;
  });

/** The image as JPEG, at most `side` on its longest edge. */
const draw = (image: HTMLImageElement, side: number, quality: number) => {
  const scale = Math.min(
    1,
    side / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    throw new PhotoUnreadable();
  }
  // A transparent PNG would turn black as a JPEG.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
};

export const shrinkPhoto = async (file: Blob): Promise<ShrunkPhoto> => {
  if (!file.type.startsWith('image/')) {
    throw new PhotoUnreadable();
  }
  const image = await load(file);
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new PhotoUnreadable();
  }
  const full = draw(image, LONGEST_SIDE, 0.85);
  return {
    type: 'image/jpeg',
    data: full.slice(full.indexOf(',') + 1),
    thumbnail: draw(image, THUMBNAIL_SIDE, 0.7),
  };
};
