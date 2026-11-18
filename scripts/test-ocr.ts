import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getLocalDocumentTools, isLocalExtractionRequest, LocalDocumentError, readLocalDocument } from '@/lib/chat-ocr.server';

function stream(bytes: Buffer, parameters = '') {
  return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${parameters} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
}

function pdf(objects: (string | Buffer)[]) {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let position = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    position += chunk.length;
  }
  const table = offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${table}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

async function image(text1: string, text2: string) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="880" height="280"><rect width="880" height="280" fill="#fff"/><g font-family="DejaVu Sans" font-size="51" fill="#000"><text x="66" y="107">${text1}</text><text x="66" y="200">${text2}</text></g></svg>`)).png().toBuffer();
}

async function main() {
  const tools = await getLocalDocumentTools();
  assert.ok(tools.pdfText && tools.pdfOcr && tools.ocrLanguages.includes('eng'), JSON.stringify(tools));
  assert.equal(isLocalExtractionRequest('Разчети текста на български'), true);
  assert.equal(isLocalExtractionRequest('Прочети PDF и го преведи на български'), false);
  assert.equal(isLocalExtractionRequest('Read the PDF and summarize it'), false);

  const root = '<< /Type /Catalog /Pages 2 0 R >>';
  const pageList = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>';
  const nativePdf = pdf([
    root, pageList,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream(Buffer.from('BT /F1 31 Tf 100 270 Td (Native SharkAI document) Tj ET')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
  const extracted = await readLocalDocument({ file: { data: nativePdf, mimeType: 'application/pdf' }, prompt: 'Прочети PDF' });
  assert.equal(extracted.text, 'Native SharkAI document');

  const english = await image('THE SEA IS BLUE', 'This is a sample scan.');
  const englishOCR = await readLocalDocument({ file: { data: english, mimeType: 'image/png' }, prompt: 'Read the image in English' });
  assert.match(englishOCR.text, /THE SEA IS BLUE/i);
  const hasBulgarian = tools.ocrLanguages.includes('bul');
  if (process.env.SHARKAI_TEST_OCR_BULGARIAN === '1') assert.ok(hasBulgarian);
  const target = hasBulgarian ? await image('БЪЛГАРСКО МОРЕ', 'Това е примерен текст.') : english;
  const scannedJpeg = await sharp(target).jpeg({ quality: 90 }).toBuffer();
  const scannedPdf = pdf([
    root, pageList,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 280] /Contents 4 0 R /Resources << /XObject << /Image1 5 0 R >> >> >>',
    stream(Buffer.from('q 620 0 0 197 10 42 cm /Image1 Do Q')),
    stream(scannedJpeg, '/Type /XObject /Subtype /Image /Width 880 /Height 280 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'),
  ]);
  const expected = hasBulgarian ? /БЪЛГАРСКО МОРЕ/iu : /THE SEA IS BLUE/i;
  const recognized = await readLocalDocument({ file: { data: scannedPdf, mimeType: 'application/pdf' }, prompt: hasBulgarian ? 'Разчети PDF на български' : 'Read the PDF in English' });
  assert.match(recognized.text, expected);
  if (hasBulgarian) {
    const imageOCR = await readLocalDocument({ file: { data: target, mimeType: 'image/png' }, prompt: 'Разчети текста на български' });
    assert.match(imageOCR.text, expected);
  }

  await assert.rejects(() => readLocalDocument({ file: { data: Buffer.from('not a pdf'), mimeType: 'application/pdf' }, prompt: 'Read the PDF' }),
    (error: unknown) => error instanceof LocalDocumentError && error.status === 415);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => readLocalDocument({ file: { data: scannedPdf, mimeType: 'application/pdf' }, prompt: 'Read the PDF', signal: abort.signal }),
    { name: 'AbortError' });
  console.log(`Local document tests passed: native PDF text, image OCR, scanned PDF OCR, invalid input and cancellation (${tools.ocrLanguages.join(', ')}).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
