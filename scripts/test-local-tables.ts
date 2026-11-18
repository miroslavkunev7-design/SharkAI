import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { hasIsolatedTableWorker, LocalTableError, runLocalTableAnalysis, supportsLocalTableAnalysis } from '../lib/chat-tables.server';
import { prisma } from '../lib/db';
import { readOwnedUpload } from '../lib/uploads';

function workbookFixture() {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 1 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append('<workbook xmlns:r="urn:fixture"><sheets><sheet name="Empty" r:id="rId1"/><sheet name="Sales" r:id="rId2"/></sheets></workbook>', { name: 'xl/workbook.xml' });
    archive.append('<Relationships><Relationship Id="rId1" Type="urn/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="urn/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>', { name: 'xl/_rels/workbook.xml.rels' });
    archive.append('<worksheet><sheetData/></worksheet>', { name: 'xl/worksheets/sheet1.xml' });
    archive.append('<sst><si><t>Amount</t></si></sst>', { name: 'xl/sharedStrings.xml' });
    archive.append('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row><row><c r="A2"><v>8</v></c></row><row><c r="A3"><f>2+2</f><v>4</v></c></row><row><c r="A4"><v>-3</v></c></row></sheetData></worksheet>', { name: 'xl/worksheets/sheet2.xml' });
    void archive.finalize().catch(reject);
  });
}

async function main() {
  const database = new URL(process.env.POSTGRES_PRISMA_URL ?? '');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname), 'Use a disposable local PostgreSQL database.');
  assert.equal(await hasIsolatedTableWorker(), true, 'A working Linux table sandbox is required.');
  const userId = 'local-table-test-' + randomUUID();
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  assert.ok(supportsLocalTableAnalysis('Обобщи CSV'));
  assert.ok(supportsLocalTableAnalysis('Направи графика от XLSX; лист: "Sales"; колона: "Amount"'));
  assert.ok(!supportsLocalTableAnalysis('Изчисли регресия и прогноза за продажби'));

  await prisma.user.create({ data: { id: userId, email: userId + '@sharkai.test', passwordHash: 'fixture' } });
  try {
    const csv = await runLocalTableAnalysis({
      file: { data: Buffer.from('Item;Amount;=TRAP\n"First; unit";10;2\nSecond;-4;9\nThird;;3\nFourth;3,50;6\n'), mimeType: 'text/csv' },
      prompt: 'Обобщи CSV',
      userId,
    });
    assert.match(csv.text, /4 реда с данни/);
    assert.match(csv.text, /Amount: 3 числа · сума 9,5/);
    assert.match(csv.text, /празни 1/);
    assert.equal(csv.artifact.filename, 'sharkai-table-summary.csv');
    const sheet = await readOwnedUpload(csv.id, userId);
    assert.ok(sheet);
    const exported = Buffer.from(sheet.data).toString('utf-8');
    assert.match(exported, /"Amount",3,1,0,9\.5,/);
    assert.match(exported, /"'=TRAP"/);
    assert.equal(await readOwnedUpload(csv.id, 'wrong-user'), null);

    const workbook = await workbookFixture();
    const plot = await runLocalTableAnalysis({
      file: { data: workbook, mimeType: xlsx },
      prompt: 'Направи графика от XLSX; лист: "Sales"; колона: "Amount"',
      userId,
    });
    assert.match(plot.text, /Лист „Sales“/);
    assert.match(plot.text, /сума 9/);
    assert.match(plot.text, /Формули: 1/);
    assert.equal(plot.artifact.filename, 'sharkai-chart.png');
    const image = await readOwnedUpload(plot.id, userId);
    assert.ok(image);
    const metadata = await sharp(Buffer.from(image.data)).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 930);

    await assert.rejects(runLocalTableAnalysis({
      file: { data: workbook, mimeType: xlsx },
      prompt: 'Направи прогноза за продажби',
      userId,
    }), LocalTableError);

    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(runLocalTableAnalysis({
      file: { data: workbook, mimeType: xlsx },
      prompt: 'Обобщи XLSX',
      userId,
      signal: stopped.signal,
    }), { name: 'AbortError' });
  } finally {
    await prisma.fileUpload.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }
  console.log('Isolated CSV/XLSX analysis passed: sandbox probe, totals, missing cells, formula-safe export, sheet selection, cached formulas, PNG output, ownership, abort and unsupported prompt.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
