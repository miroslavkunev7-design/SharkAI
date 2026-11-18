import sharp from 'sharp';
import { saveUpload, validateUpload } from './uploads';

export type LocalImageEdit =
  | { operation: 'resize'; width: number; height?: number }
  | { operation: 'crop'; width: number; height: number; left?: number; top?: number }
  | { operation: 'rotate'; degrees: number }
  | { operation: 'grayscale' }
  | { operation: 'flip'; axis: 'horizontal' | 'vertical' }
  | { operation: 'temperature'; tone: 'warm' | 'cool' }
  | { operation: 'saturation'; percentage: number };

export class LocalImageEditError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const object = String.raw`(?:(?:(?:the|this|attached|the attached) )?(?:image|photo|picture|file)|it|изображението|снимката|картинката|прикачената снимка|прикаченото изображение|го|я)`;
const imageObject = `(?: ${object})?`;
const pixels = String.raw`(?: ?(?:px|пиксела?))?`;
const dimension = String.raw`([0-9]{1,6})`;
const dimensions = String.raw`${dimension}\s*(?:x|х|×|на|по)\s*${dimension}${pixels}`;
const resize = new RegExp(String.raw`^(?:resize|преоразмери|оразмери)${imageObject} (?:to |до |на )?${dimensions}$`, 'u');
const resizeWidth = new RegExp(String.raw`^(?:resize|преоразмери|оразмери)${imageObject} (?:to |до |на )?(?:width |ширина )${dimension}${pixels}$`, 'u');
const crop = new RegExp(String.raw`^(?:crop|изрежи|изкропни)${imageObject} (?:от центъра |from (?:the )?cent(?:er|re) )?(?:to |до |на )?${dimensions}(?: (?:в центъра|centered)| (?:at|от) x\s*[=:]\s*${dimension}\s*,\s*y\s*[=:]\s*${dimension})?$`, 'u');
const rotate = new RegExp(String.raw`^(?:rotate|завърти)${imageObject} (?:by |на |с )?([+-]?\d{1,6})(?:\s*(?:°|degrees?|deg|градуса?))?(?: (clockwise|counterclockwise|anticlockwise|по часовниковата стрелка|обратно на часовниковата стрелка|наляво|надясно))?$`, 'u');
const tones = String.raw`(?:grayscale|greyscale|black(?: and |-)white|черно(?:-| и )бял[оа]|в сивата гама)`;
const grayscale = new RegExp(String.raw`^(?:(?:make|convert|turn|направи|превърни)${imageObject} (?:to |in |в )?)?${tones}$`, 'u');
const warm = /^(?:затопли (?:цветовете|тоновете)|направи (?:цветовете|тоновете) по[- ]топли|warm (?:the )?(?:colou?rs|tones)|make (?:the |this )?(?:image|photo|picture|colou?rs|tones) warmer)$/u;
const cool = /^(?:охлади (?:цветовете|тоновете)|направи (?:цветовете|тоновете) по[- ]студени|cool (?:the )?(?:colou?rs|tones)|make (?:the |this )?(?:image|photo|picture|colou?rs|tones) cooler)$/u;
const saturation = /^(?:set (?:the )?saturation to|(?:задай|настрой) (?:наситеността|цветната наситеност) (?:на|до)) ([+-]?\d{1,5}(?:[.,]\d{1,2})?) ?%$/u;
const flip = new RegExp(String.raw`^(?:flip|mirror|обърни|огледай)${imageObject} (?:по )?(horizontal(?:ly)?|vertical(?:ly)?|хоризонтално|вертикално)$`, 'u');

export function parseLocalImageEdit(prompt: string): LocalImageEdit | null {
  const command = prompt.normalize('NFKC').toLowerCase().trim()
    .replace(/\s+/g, ' ').replace(/^(?:please|моля)[ ,]+/u, '').replace(/[.!?]+$/u, '').trim();
  const size = resize.exec(command) ?? resizeWidth.exec(command);
  if (size) return { operation: 'resize', width: Number(size[1]), height: size[2] === undefined ? undefined : Number(size[2]) };

  const area = crop.exec(command);
  if (area) return {
    operation: 'crop', width: Number(area[1]), height: Number(area[2]),
    left: area[3] === undefined ? undefined : Number(area[3]), top: area[4] === undefined ? undefined : Number(area[4]),
  };

  const rotation = rotate.exec(command);
  if (rotation) {
    const value = Number(rotation[1]);
    const direction = rotation[2] ?? '';
    const left = /^(?:counterclockwise|anticlockwise|обратно|наляво)/u.test(direction);
    return { operation: 'rotate', degrees: left ? -Math.abs(value) : value };
  }

  if (grayscale.test(command)) return { operation: 'grayscale' };
  const reflection = flip.exec(command);
  if (reflection) return { operation: 'flip', axis: /^(?:horizontal|хоризонтално)/u.test(reflection[1]) ? 'horizontal' : 'vertical' };
  if (warm.test(command)) return { operation: 'temperature', tone: 'warm' };
  if (cool.test(command)) return { operation: 'temperature', tone: 'cool' };
  const percentage = saturation.exec(command);
  if (percentage) return { operation: 'saturation', percentage: Number(percentage[1].replace(',', '.')) };
  return null;
}

const maximumInputPixels = 16_000_000;
const maximumOutputSide = 6000;
const maximumOutputBytes = 25 * 1024 * 1024;
const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const pngMime = 'image/png';

function checkSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > maximumOutputSide || height > maximumOutputSide || width * height > maximumInputPixels) {
    throw new LocalImageEditError('Крайният размер трябва да е до 6000 px на страна и до 16 мегапиксела.', 422);
  }
}

export async function runLocalImageEdit({ edit, file, userId, signal }: {
  edit: LocalImageEdit;
  file: { data: Buffer; mimeType: string };
  userId: string;
  signal?: AbortSignal;
}) {
  signal?.throwIfAborted();
  if (!acceptedTypes.has(file.mimeType) || !validateUpload(file.data, file.mimeType)) {
    throw new LocalImageEditError('Прикачи валидно PNG, JPEG или WebP изображение.', 415);
  }

  const input = sharp(file.data, { limitInputPixels: maximumInputPixels, autoOrient: true }).timeout({ seconds: 12 });
  const metadata = await input.metadata().catch(() => null);
  const width = metadata?.autoOrient.width;
  const height = metadata?.autoOrient.height;
  if (!width || !height || (metadata?.pages ?? 1) > 1) {
    throw new LocalImageEditError('Изображението не може да се обработи. Използвай единична снимка до 16 мегапиксела.', 422);
  }

  switch (edit.operation) {
    case 'resize': {
      const targetHeight = edit.height ?? Math.max(1, Math.round(height * edit.width / width));
      checkSize(edit.width, targetHeight);
      input.resize(edit.width, targetHeight, { fit: 'contain', background: 'transparent' });
      break;
    }
    case 'crop': {
      checkSize(edit.width, edit.height);
      const left = edit.left ?? Math.floor((width - edit.width) / 2);
      const top = edit.top ?? Math.floor((height - edit.height) / 2);
      if (left < 0 || top < 0 || left + edit.width > width || top + edit.height > height) {
        throw new LocalImageEditError(`Областта за изрязване излиза извън снимката (${width} × ${height} px).`, 422);
      }
      input.extract({ left, top, width: edit.width, height: edit.height });
      break;
    }
    case 'rotate': {
      const radians = edit.degrees % 360 * Math.PI / 180;
      const x = Math.abs(Math.cos(radians));
      const y = Math.abs(Math.sin(radians));
      checkSize(Math.round(width * x + height * y), Math.round(width * y + height * x));
      input.rotate(edit.degrees % 360, { background: 'transparent' });
      break;
    }
    case 'grayscale':
      checkSize(width, height);
      input.grayscale();
      break;
    case 'flip':
      checkSize(width, height);
      if (edit.axis === 'horizontal') input.flop();
      else input.flip();
      break;
    case 'temperature':
    case 'saturation': {
      checkSize(width, height);
      // Keep 16-bit PNG precision and leave the alpha channel out of the adjustment.
      const space = metadata?.depth === 'ushort' ? 'rgb16' : 'srgb';
      input.pipelineColourspace(space).toColourspace(space);
      if (edit.operation === 'temperature') {
        input.linear(edit.tone === 'warm' ? [1.08, 1, 0.92] : [0.92, 1, 1.08], [0, 0, 0]);
      } else {
        const { percentage } = edit;
        if (!Number.isFinite(percentage) || percentage < 0 || percentage > 200) {
          throw new LocalImageEditError('Задай наситеност от 0% до 200% спрямо оригинала.', 422);
        }
        if (percentage !== 100) input.modulate({ saturation: percentage / 100 });
      }
      break;
    }
  }

  const result = await input.png().toBuffer({ resolveWithObject: true }).catch(() => null);
  if (!result) throw new LocalImageEditError('Промяната не можа да се приложи към изображението.', 422);
  checkSize(result.info.width, result.info.height);
  if (result.data.length > maximumOutputBytes) throw new LocalImageEditError('Крайният PNG файл надхвърля 25 MB.', 413);
  signal?.throwIfAborted();
  const saved = await saveUpload(result.data, pngMime, userId);
  const url = `/api/upload/${saved.id}`;
  return {
    id: saved.id,
    status: 'completed' as const,
    text: `Готово. Запазих отделен PNG файл (${result.info.width} × ${result.info.height} px).`,
    url,
    artifact: { url, mimeType: pngMime },
  };
}
