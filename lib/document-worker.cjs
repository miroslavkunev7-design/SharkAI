const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const {
  AnnotationFlags, PDFArray, PDFButton, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown,
  PDFName, PDFNumber, PDFOptionList, PDFRadioGroup, PDFSignature, PDFTextField, PageSizes, degrees, rgb,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const MAX_PAGES = 250;
const MAX_FORM_FIELDS = 50;
const MAX_FORM_FIELD_NAME = 160;
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

async function embeddedTextFont(pdf, body, subset = true) {
  pdf.registerFontkit(fontkit);
  const bytes = await readFile(path.join(__dirname, 'document-fonts', 'NotoSans-Regular.ttf'));
  const font = await pdf.embedFont(bytes, { subset });
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

function formFieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) return 'choice';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unsupported';
}

function formFieldRestriction(field, calculated) {
  if (field.isReadOnly()) return 'само за четене';
  if (!(field instanceof PDFTextField)) return 'поддържат се само текстови полета';
  const additionalActions = PDFName.of('AA');
  const widgets = field.acroField.getWidgets();
  if (calculated.has(field.ref.toString()) || field.acroField.getInheritableAttribute(additionalActions)
    || widgets.some((widget) => widget.dict.has(additionalActions))) return 'автоматично управлявано поле';
  if (field.isPassword() || field.isFileSelector() || field.isRichFormatted()) return 'специализиран формат';
  if (!widgets.some((widget) => !widget.hasFlag(AnnotationFlags.Hidden) && !widget.hasFlag(AnnotationFlags.NoView))) {
    return 'няма видима контрола';
  }
}

function formFields(pdf) {
  const form = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!form) return [];
  if (form.has(PDFName.of('XFA'))) throw new DocumentFailure('Този PDF използва XFA формуляр. Поддържат се стандартни AcroForm полета.');
  const fields = pdf.getForm().getFields();
  if (fields.length > MAX_FORM_FIELDS) throw new DocumentFailure(`Локалният PDF редактор поддържа до ${MAX_FORM_FIELDS} полета.`);
  const calculated = new Set(form.lookupMaybe(PDFName.of('CO'), PDFArray)?.asArray().map((field) => field.toString()));
  return fields.map((field) => {
    const name = field.getName();
    if (!name.trim() || name.length > MAX_FORM_FIELD_NAME || /[\p{Cc}\p{Cs}]/u.test(name)) {
      throw new DocumentFailure('Формулярът съдържа поле с неподдържано име.');
    }
    return { name, type: formFieldType(field), restriction: formFieldRestriction(field, calculated), field };
  });
}

function registerFormFont(pdf, font) {
  const form = pdf.getForm().acroForm.dict;
  const resourceKey = PDFName.of('DR');
  const fontKey = PDFName.of('Font');
  const resources = form.lookupMaybe(resourceKey, PDFDict) ?? pdf.context.obj({});
  const fonts = resources.lookupMaybe(fontKey, PDFDict) ?? pdf.context.obj({});
  const currentName = PDFName.of(font.name);
  const alias = fonts.has(currentName) ? fonts.uniqueKey('SharkAIForm') : currentName;
  // Keep the field's default appearance font resolvable when a viewer edits the value.
  font.name = alias.decodeText();
  fonts.set(alias, font.ref);
  resources.set(fontKey, fonts);
  form.set(resourceKey, resources);
}

async function fillFormField(pdf, action) {
  const matches = formFields(pdf).filter(({ name }) => name === action.name);
  if (matches.length !== 1) {
    throw new DocumentFailure(matches.length ? 'Името съвпада с няколко полета. Посочи еднозначно поле.' : 'Полето не е намерено. Използвай точното име от списъка с полета.');
  }
  const { field, restriction } = matches[0];
  if (restriction) throw new DocumentFailure(`Полето не може да се попълни: ${restriction}.`);
  const { value } = action;
  const maxLength = field.getMaxLength();
  if (maxLength !== undefined && value.length > maxLength) throw new DocumentFailure(`Полето допуска до ${maxLength} знака.`);
  if ((!field.isMultiline() && value.includes('\n')) || value.includes('\t')) {
    throw new DocumentFailure('Текстът съдържа табулация или нов ред, който полето не поддържа.');
  }
  if ((field.getText() ?? '') === value) throw new DocumentFailure('Тази стойност вече е записана в полето.');
  const font = await embeddedTextFont(pdf, value, false);
  registerFormFont(pdf, font);
  field.setText(value || undefined);
  field.updateAppearances(font);
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
  if (action.kind === 'list-fields') {
    const form = formFields(pdf);
    const signed = form.some(({ restriction }) => !restriction) && hasSignature(pdf);
    const fields = form.map(({ name, type, restriction }) => {
      const reason = restriction ?? (signed ? 'документът е цифрово подписан' : undefined);
      return { name, type, editable: !reason, reason };
    });
    parentPort.postMessage({ fields });
    return;
  }
  if (original && hasSignature(pdf)) throw new DocumentFailure('PDF съдържа цифров подпис. Използвай неподписано копие за редакция.');
  if (action.kind === 'append') await appendText(pdf, action.body);
  else if (action.kind === 'overlay-text') await overlayText(pdf, action);
  else if (action.kind === 'fill-field') await fillFormField(pdf, action);
  else editPages(pdf, action);
  const bytes = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
  parentPort.postMessage({ bytes }, [bytes.buffer]);
}

run().catch((error) => {
  parentPort.postMessage({ error: error instanceof DocumentFailure ? error.message : 'PDF файлът не можа да бъде обработен.' });
});
