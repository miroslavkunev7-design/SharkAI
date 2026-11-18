const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { DOMParser } = require('@xmldom/xmldom');
const { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const sharp = require('sharp');
const yauzl = require('yauzl');

const base = new URL(process.env.SHARKAI_TEST_URL || 'http://127.0.0.1:3847');
assert(process.env.POSTGRES_PRISMA_URL, 'Configure a disposable local PostgreSQL database.');
const database = new URL(process.env.POSTGRES_PRISMA_URL);
const local = ['localhost', '127.0.0.1', '[::1]'];
assert(local.includes(base.hostname) && local.includes(database.hostname), 'Use a local app and database.');
const prisma = new PrismaClient();
const tag = randomUUID();
const emails = [`file-context-a-${tag}@example.test`, `file-context-b-${tag}@example.test`];
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function request(path, cookie, options = {}) {
  return fetch(new URL(path, base), {
    signal: AbortSignal.timeout(25_000), ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
  });
}

function jsonBody(body) {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
}

async function account(email) {
  const response = await request('/api/auth/register', null, jsonBody({ email, password: randomUUID() }));
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie && payload.user.id);
  return { id: payload.user.id, cookie };
}

async function ask(actor, conversationId, input, expected = 200) {
  const response = await request('/api/chat', actor.cookie, jsonBody({
    conversationId, requestId: randomUUID(), mode: 'work', ...input,
  }));
  const result = await response.json();
  assert.equal(response.status, expected, `${input.message}: ${result.error ?? result.content}`);
  return result;
}

async function png(name, width, height, actor) {
  const content = await sharp({ create: { width, height, channels: 3, background: '#156baf' } }).png().toBuffer();
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'image/png' }), name);
  const response = await request('/api/upload', actor.cookie, { method: 'POST', body: form });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  assert(data.uploadId);
  return data.uploadId;
}

async function readArtifact(actor, result, mimeType) {
  const artifact = result.toolResult?.artifact;
  assert(artifact && artifact.mimeType === mimeType, JSON.stringify(result.toolResult));
  const match = /^\/api\/upload\/([0-9a-f-]{36})(?:\?|$)/i.exec(artifact.url);
  assert(match);
  const response = await request(artifact.url, actor.cookie);
  assert.equal(response.status, 200);
  return { id: match[1], url: artifact.url, bytes: Buffer.from(await response.arrayBuffer()) };
}

function attachment(result, id, mimeType) {
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].imagePath, id);
  assert.equal(result.messages[0].attachmentMime, mimeType);
}

function zipEntry(bytes, filename) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.once('error', reject);
      zip.once('end', () => reject(new Error(`Missing ${filename}`)));
      zip.on('entry', (entry) => {
        if (entry.fileName !== filename) { zip.readEntry(); return; }
        zip.openReadStream(entry, (failure, stream) => {
          if (failure) { zip.close(); reject(failure); return; }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.once('error', reject);
          stream.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); zip.close(); });
        });
      });
      zip.readEntry();
    });
  });
}

async function spreadsheetCell(bytes, address) {
  const worksheet = new DOMParser().parseFromString(await zipEntry(bytes, 'xl/worksheets/sheet1.xml'), 'application/xml');
  const cell = Array.from(worksheet.getElementsByTagName('c')).find((node) => node.getAttribute('r') === address);
  return cell?.getElementsByTagName('v').item(0)?.textContent;
}

function pdfDrawings(pdf) {
  const page = pdf.getPage(0);
  const contents = page.node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray().map((entry) => pdf.context.lookup(entry)) : [contents];
  return streams.flatMap((stream) => stream instanceof PDFRawStream ? [Buffer.from(decodePDFRawStream(stream).decode()).toString('ascii')] : []);
}

async function seedWindow(actor, imageId, laterTurns) {
  const id = randomUUID();
  await prisma.chatConversation.create({ data: { id, userId: actor.id, title: 'Retention boundary fixture', mode: 'work' } });
  const start = Date.now() - (laterTurns + 3) * 250;
  const rows = [];
  for (let index = 0; index <= laterTurns; index++) {
    const requestId = randomUUID();
    const shared = { userId: actor.id, conversationId: id, requestId };
    rows.push({ ...shared, role: 'user', content: `Window request ${index}`, createdAt: new Date(start + index * 250),
      ...(index === 0 ? { imagePath: imageId, attachmentMime: 'image/png' } : {}) });
    rows.push({ ...shared, role: 'assistant', content: `Window reply ${index}`, createdAt: new Date(start + index * 250 + 1) });
  }
  await prisma.chatMessage.createMany({ data: rows });
  return id;
}

async function run() {
  const [owner, stranger] = await Promise.all(emails.map(account));
  const imageId = await png('retained-source-fixture.png', 12, 8, owner);
  const overrideId = await png('explicit-override-fixture.png', 30, 10, owner);
  const conversation = randomUUID();
  const initial = await ask(owner, conversation, { toolId: 'image-properties', message: 'Image properties', uploadId: imageId });
  attachment(initial, imageId, 'image/png');

  const sheet = await ask(owner, conversation, { toolId: 'spreadsheet-export', message: 'Create XLSX with data:\nItem,Value\nPear,10\nPlum,20' });
  attachment(sheet, null, null);
  const xlsx = await readArtifact(owner, sheet, xlsxMime);
  assert.equal(await spreadsheetCell(xlsx.bytes, 'B2'), '10');

  const resize = await ask(owner, conversation, { toolId: 'image-edit', message: 'Resize the image to 8x6' });
  attachment(resize, imageId, 'image/png');
  const resized = await readArtifact(owner, resize, 'image/png');
  const dimensions = await sharp(resized.bytes).metadata();
  assert.equal(dimensions.width, 8);
  assert.equal(dimensions.height, 6);

  const editSheet = await ask(owner, conversation, { toolId: 'spreadsheet-edit', message: 'Edit XLSX: set cell B2 to 17' });
  attachment(editSheet, xlsx.id, xlsxMime);
  const amended = await readArtifact(owner, editSheet, xlsxMime);
  assert.equal(await spreadsheetCell(amended.bytes, 'B2'), '17');
  assert.equal(await spreadsheetCell(xlsx.bytes, 'B2'), '10');

  const pdfTurn = await ask(owner, conversation, { toolId: 'document-export', message: 'Create PDF with content:\nRetention test PDF. This source line stays.' });
  const pdf = await readArtifact(owner, pdfTurn, 'application/pdf');
  const originalPdf = await PDFDocument.load(pdf.bytes);
  const docx = await ask(owner, conversation, { toolId: 'document-export', message: 'Create DOCX with content:\nA newer, incompatible document.' });
  await readArtifact(owner, docx, docxMime);
  const overlay = await ask(owner, conversation, {
    toolId: 'document-edit', message: 'Редактирай PDF: Добави текст на страница 1 при x=48, y=60, размер 12: REVIEWED_CONTEXT',
  });
  attachment(overlay, pdf.id, 'application/pdf');
  const labeled = await readArtifact(owner, overlay, 'application/pdf');
  const editedPdf = await PDFDocument.load(labeled.bytes);
  assert.equal(editedPdf.getPageCount(), originalPdf.getPageCount());
  const previousDrawings = pdfDrawings(originalPdf);
  assert(pdfDrawings(editedPdf).some((stream) => !previousDrawings.includes(stream) && /\bTm\b/.test(stream)));
  assert.deepEqual(Buffer.from(await (await request(pdf.url, owner.cookie)).arrayBuffer()), pdf.bytes);

  await ask(owner, conversation, { toolId: 'image-properties', message: 'Image properties', uploadId: xlsx.id }, 415);
  await ask(owner, conversation, { toolId: 'image-properties', message: 'Image properties', uploadId: randomUUID() }, 404);
  const preferred = await ask(owner, conversation, { toolId: 'image-properties', message: 'Image properties', uploadId: overrideId });
  attachment(preferred, overrideId, 'image/png');
  assert.match(preferred.toolResult.text, /30\s*[×x]\s*10/);
  const named = { toolId: 'image-properties', message: 'Image properties of "retained-source-fixture.png"' };
  await ask(owner, conversation, named, 400);
  await ask(owner, conversation, { toolId: 'image-properties', message: 'Inspect the first image' }, 400);
  const reattached = await ask(owner, conversation, { ...named, uploadId: imageId });
  attachment(reattached, imageId, 'image/png');
  assert.match(reattached.toolResult.text, /12\s*[×x]\s*8/);
  await ask(stranger, randomUUID(), { toolId: 'image-properties', message: 'Image properties', uploadId: imageId }, 404);
  assert.equal((await request(resized.url, stranger.cookie)).status, 404);
  await ask(owner, randomUUID(), { toolId: 'image-properties', message: 'Image properties of retained-source-fixture.png' }, 400);

  const forkTarget = { conversationId: conversation, messageId: sheet.messages[0].id };
  await ask(stranger, randomUUID(), { branchFrom: forkTarget, toolId: 'image-properties', message: 'Measure the earlier image' }, 404);
  await ask(owner, randomUUID(), {
    branchFrom: { conversationId: conversation, messageId: initial.messages[0].id },
    toolId: 'image-properties', message: 'Measure the earlier image',
  }, 400);
  const forkId = randomUUID();
  const inherited = await ask(owner, forkId, { branchFrom: forkTarget, toolId: 'image-properties', message: 'Measure the earlier image' });
  attachment(inherited, imageId, 'image/png');
  assert.match(inherited.toolResult.text, /12\s*[×x]\s*8/);
  const fork = await request(`/api/chat?conversationId=${forkId}`, owner.cookie);
  assert.equal(fork.status, 200);
  assert.equal((await fork.json()).messages.length, 4, 'Only the prefix and new pair belong in the fork.');

  const bounded = await seedWindow(owner, imageId, 23);
  attachment(await ask(owner, bounded, { toolId: 'image-properties', message: 'Measure the earlier image' }), imageId, 'image/png');
  const expired = await seedWindow(owner, imageId, 24);
  await ask(owner, expired, { toolId: 'image-properties', message: 'Measure the earlier image' }, 400);

  const project = await ask(owner, conversation, { message: 'Build a website for a bookstore with contacts and opening hours.' });
  attachment(project, null, null);
  assert.equal(project.toolResult?.toolId, 'prompt-software');
  assert(project.toolResult.projectId);
  const projectId = project.toolResult.projectId;
  let projectFinished = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const details = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } });
    if (details && ['COMPLETED', 'FAILED'].includes(details.status)) { projectFinished = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(projectFinished, 'The Studio fixture has not reached a terminal status.');

  const csv = await ask(owner, conversation, { toolId: 'spreadsheet-export', message: 'Create CSV with data:\nCategory,Amount\nOld data,10' });
  attachment(csv, null, null);
  const record = await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { tokensLimit: true, tokensUsed: true } });
  await prisma.user.update({ where: { id: owner.id }, data: { tokensUsed: record.tokensLimit } });
  const unrelatedId = randomUUID();
  await ask(owner, conversation, { requestId: unrelatedId, message: 'Show why the Earth has seasons. Answer in English.' }, 429);
  assert.equal(await prisma.chatMessage.count({ where: { userId: owner.id, requestId: unrelatedId } }), 0);
  await prisma.user.update({ where: { id: owner.id }, data: { tokensUsed: record.tokensUsed } });
  console.log('File context passed across actual PNG, XLSX and PDF bytes, mixed in-conversation types, upload overrides, forks, owner isolation, 24-turn retention and unrelated/project routing.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});
