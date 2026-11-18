const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PageSizes, degrees, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const MAX_PAGES = 250;
const BODY_FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const PAGE_MARGIN = 52;
const OVERLAY_MARGIN = 36;
const INK = rgb(0.08, 0.12, 0.19);

class DocumentFailure extends Error {}

function wrapLine(text, font, maxWidth) {
  if (!text) return [''];
  const width = (value) => font.widthOfTextAtSize(value, BODY_FONT_SIZE);
  const lines = [];
  let current = '';
  for (const word of text.trimEnd().split(/\s+/u)) {
    const next = current ? `${current} ${word}` : word;
    if (width(next) <= maxWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = '';
    for (const character of word) {
      if (width(current + character) > maxWidth && current) {
        lines.push(current);
        current = '';
      }
      current += character;
    }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

async function embeddedTextFont(pdf, body) {
  pdf.registerFontkit(fontkit);
  const bytes = await readFile(path.join(__dirname, 'document-fonts', 'NotoSans-Regular.ttf'));
  const font = await pdf.embedFont(bytes, { subset: true });
  const coverage = new Set(font.getCharacterSet());
  if ([...body].some((character) => !/\s/u.test(character) && !coverage.has(character.codePointAt(0)))) {
    throw new DocumentFailure('PDF шрифтът не поддържа част от символите в текста. Избери DOCX за това съдържание.');
  }
  return font;
}

async function appendText(pdf, body) {
  const font = await embeddedTextFont(pdf, body);
  const existing = pdf.getPages().at(-1)?.getSize();
  const size = existing && existing.width >= 220 && existing.height >= 220 ? [existing.width, existing.height] : PageSizes.A4;
  const [width, height] = size;
  let page;
  let y = 0;
  for (const paragraph of body.split(/\r?\n/u)) {
    for (const line of wrapLine(paragraph.replace(/\t/g, '    '), font, width - PAGE_MARGIN * 2)) {
      if (y < PAGE_MARGIN) {
        if (pdf.getPageCount() >= MAX_PAGES) throw new DocumentFailure(`Файлът надхвърля ${MAX_PAGES} страници.`);
        page = pdf.addPage(size);
        y = height - PAGE_MARGIN;
      }
      if (line) page.drawText(line, { x: PAGE_MARGIN, y, font, size: BODY_FONT_SIZE, color: INK });
      y -= LINE_HEIGHT;
    }
  }
}

function existingPageIndex(pdf, action) {
  const total = pdf.getPageCount();
  const index = action.page - 1;
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new DocumentFailure(`Файлът има ${total} страници. Посочи съществуваща страница.`);
  return index;
}

function editPages(pdf, action) {
  const index = existingPageIndex(pdf, action);
  if (action.kind === 'remove-page') {
    if (pdf.getPageCount() === 1) throw new DocumentFailure('PDF трябва да има поне една страница.');
    pdf.removePage(index);
  } else {
    const page = pdf.getPage(index);
    page.setRotation(degrees((page.getRotation().angle + action.angle + 360) % 360));
  }
}

function hasSignature(pdf) {
  const type = PDFName.of('Type');
  const signature = PDFName.of('Sig');
  const byteRange = PDFName.of('ByteRange');
  const contents = PDFName.of('Contents');
  const pending = pdf.context.enumerateIndirectObjects().map(([, object]) => object);
  while (pending.length) {
    const object = pending.pop();
    if (object instanceof PDFDict) {
      if (object.get(type) === signature || (object.has(byteRange) && object.has(contents))) return true;
      for (const [, value] of object.entries()) pending.push(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) pending.push(value);
    }
  }
  return false;
}

function visiblePage(page) {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const left = Math.max(crop.x, media.x);
  const bottom = Math.max(crop.y, media.y);
  const width = Math.min(crop.x + crop.width, media.x + media.width) - left;
  const height = Math.min(crop.y + crop.height, media.y + media.height) - bottom;
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  if (![left, bottom, width, height, unit].every(Number.isFinite) || width <= 0 || height <= 0
    || unit <= 0 || ![0, 90, 180, 270].includes(angle)) {
    throw new DocumentFailure('Не може да се определи видимата област на PDF страницата.');
  }
  return { left, bottom, width, height, angle, unit };
}

async function overlayText(pdf, action) {
  const page = pdf.getPage(existingPageIndex(pdf, action));
  if (hasSignature(pdf)) throw new DocumentFailure('PDF съдържа цифров подпис. Използвай неподписано копие за добавяне на надпис.');
  const { left, bottom, width, height, angle, unit } = visiblePage(page);
  const displayedWidth = angle % 180 ? height : width;
  const displayedHeight = angle % 180 ? width : height;
  const font = await embeddedTextFont(pdf, action.body);
  const size = action.size / unit;
  const lines = action.body.split('\n');
  const lineHeight = size * 1.35;
  const textWidth = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size)));
  const textHeight = font.heightAtSize(size) + (lines.length - 1) * lineHeight;
  const ascent = font.heightAtSize(size, { descender: false });
  const margin = OVERLAY_MARGIN / unit;
  const { placement } = action;
  const offsetX = 'x' in placement ? placement.x / unit : placement.corner.endsWith('right') ? displayedWidth - margin - textWidth : margin;
  const offsetY = 'y' in placement ? placement.y / unit : placement.corner.startsWith('bottom') ? displayedHeight - margin - textHeight : margin;
  if (offsetX < 0 || offsetY < 0 || offsetX + textWidth > displayedWidth || offsetY + textHeight > displayedHeight) {
    throw new DocumentFailure('Надписът не се побира на видимата страница. Съкрати текста, добави нов ред или промени позицията и размера.');
  }

  // Map the displayed top-left coordinate and upright text back to PDF page coordinates.
  const toPage = {
    0: (x, y) => [x, height - y],
    90: (x, y) => [y, x],
    180: (x, y) => [width - x, y],
    270: (x, y) => [width - y, height - x],
  }[angle];
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    const [x, y] = toPage(offsetX, offsetY + ascent + index * lineHeight);
    page.drawText(line, { x: left + x, y: bottom + y, font, size, color: INK, rotate: degrees(angle) });
  }
}

async function run() {
  const { original, action } = workerData;
  let pdf;
  try {
    pdf = original
      ? await PDFDocument.load(original, { updateMetadata: false, throwOnInvalidObject: true })
      : await PDFDocument.create();
  } catch {
    throw new DocumentFailure('PDF файлът не може да се отвори. Възможно е да е заключен или повреден.');
  }
  if (pdf.getPageCount() > MAX_PAGES) throw new DocumentFailure(`Локалният редактор обработва до ${MAX_PAGES} страници.`);
  if (action.kind === 'append') await appendText(pdf, action.body);
  else if (action.kind === 'overlay-text') await overlayText(pdf, action);
  else editPages(pdf, action);
  const bytes = await pdf.save({ useObjectStreams: true, updateFieldAppearances: action.kind !== 'overlay-text' });
  parentPort.postMessage({ bytes }, [bytes.buffer]);
}

run().catch((error) => {
  parentPort.postMessage({ error: error instanceof DocumentFailure ? error.message : 'PDF файлът не можа да бъде обработен.' });
});
