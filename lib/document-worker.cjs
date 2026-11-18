const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { PDFDocument, PageSizes, degrees, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const MAX_PAGES = 250;
const BODY_FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const PAGE_MARGIN = 52;

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

async function appendText(pdf, body) {
  pdf.registerFontkit(fontkit);
  const bytes = await readFile(path.join(__dirname, 'document-fonts', 'NotoSans-Regular.ttf'));
  const font = await pdf.embedFont(bytes, { subset: true });
  const coverage = new Set(font.getCharacterSet());
  if ([...body].some((character) => !/\s/u.test(character) && !coverage.has(character.codePointAt(0)))) {
    throw new DocumentFailure('PDF шрифтът не поддържа част от символите в текста. Избери DOCX за това съдържание.');
  }
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
      if (line) page.drawText(line, { x: PAGE_MARGIN, y, font, size: BODY_FONT_SIZE, color: rgb(0.08, 0.12, 0.19) });
      y -= LINE_HEIGHT;
    }
  }
}

function editPages(pdf, action) {
  const total = pdf.getPageCount();
  const index = action.page - 1;
  if (index < 0 || index >= total) throw new DocumentFailure(`Файлът има ${total} страници. Посочи съществуваща страница.`);
  if (action.kind === 'remove-page') {
    if (total === 1) throw new DocumentFailure('PDF трябва да има поне една страница.');
    pdf.removePage(index);
  } else {
    const page = pdf.getPage(index);
    page.setRotation(degrees((page.getRotation().angle + action.angle + 360) % 360));
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
  else editPages(pdf, action);
  const bytes = await pdf.save({ useObjectStreams: true });
  parentPort.postMessage({ bytes }, [bytes.buffer]);
}

run().catch((error) => {
  parentPort.postMessage({ error: error instanceof DocumentFailure ? error.message : 'PDF файлът не можа да бъде обработен.' });
});
