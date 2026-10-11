/*
 * A photo made small enough to send quickly: a JPEG no longer than this on
 * its longest side. A phone photo of several megabytes becomes a few hundred
 * kilobytes, and its location and camera details are left behind with the
 * original. The server shrinks it further, to what the model is paid to
 * read, so this only needs to keep it legible.
 */

const LONGEST_SIDE = 1600;
/** Kept with the conversation so the photo shows beside what was asked. */
const THUMBNAIL_SIDE = 240;

export interface ShrunkPhoto {
  type: 'image/jpeg';
  /** The JPEG's bytes as base64, to send. */
  data: string;
  /** A small copy to show in the conversation, as a data URL. */
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

/** The picture drawn no larger than `side` on its longest edge, as JPEG. */
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
