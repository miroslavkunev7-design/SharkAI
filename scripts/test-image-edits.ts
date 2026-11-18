import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { LocalImageEditError, parseLocalImageEdit, runLocalImageEdit } from '@/lib/chat-image-edits.server';
import { prisma } from '@/lib/db';
import { readOwnedUpload, saveUpload } from '@/lib/uploads';

async function main() {
  assert.equal(process.env.SHARKAI_TEST_IMAGE_EDITS, '1', 'Use a disposable PostgreSQL database');
  process.env.USE_DB_UPLOADS = 'true';
  assert.equal(parseLocalImageEdit('Remove the background and resize to 600x400'), null);
  assert.equal(parseLocalImageEdit('Кажи ми как да преоразмеря снимката'), null);
  assert.deepEqual(parseLocalImageEdit('Моля, завърти снимката на 90° наляво.'), { operation: 'rotate', degrees: -90 });
  assert.deepEqual(parseLocalImageEdit('Направи цветовете по-топли.'), { operation: 'temperature', tone: 'warm' });
  assert.deepEqual(parseLocalImageEdit('Cool the colors!'), { operation: 'temperature', tone: 'cool' });
  assert.deepEqual(parseLocalImageEdit('Задай наситеността на 60,5%'), { operation: 'saturation', percentage: 60.5 });
  for (const generative of [
    'Edit the image so the mountain lake has a vivid orange sunset',
    'Make the image warmer and replace the background with mountains',
    'Make the sky warmer',
    'Направи цветовете по-топли и добави залез',
    'Set saturation to 60% and remove the background',
    'Как да направя цветовете по-студени?',
  ]) assert.equal(parseLocalImageEdit(generative), null, generative);

  const ownerIds: string[] = [];
  async function createOwner() {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, passwordHash: 'test-only' } });
    ownerIds.push(user.id);
    return user.id;
  }

  try {
    const owner = await createOwner();
    const otherOwner = await createOwner();
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const input = await sharp(pixels, { raw: { width: 3, height: 2, channels: 4 } }).png().toBuffer();
    const file = { mimeType: 'image/png', data: input };
    const original = await saveUpload(input, file.mimeType, owner);

    async function transform(prompt: string, source = file, depth: 'uchar' | 'ushort' = 'uchar') {
      const edit = parseLocalImageEdit(prompt);
      assert.ok(edit, `Unrecognized edit: ${prompt}`);
      const artifact = await runLocalImageEdit({ edit, file: source, userId: owner });
      assert.notEqual(artifact.id, original.id);
      assert.equal(artifact.url, `/api/upload/${artifact.id}`);
      assert.equal(await readOwnedUpload(artifact.id, otherOwner), null);
      const stored = await readOwnedUpload(artifact.id, owner);
      assert.ok(stored);
      assert.equal(stored.mimeType, 'image/png');
      const image = sharp(stored.data);
      assert.equal((await image.metadata()).depth, depth);
      return image.toColourspace(depth === 'ushort' ? 'rgb16' : 'srgb').ensureAlpha().raw({ depth }).toBuffer({ resolveWithObject: true });
    }

    const resized = await transform('Преоразмери изображението до 8 × 8 пиксела.');
    assert.equal(resized.info.width, 8);
    assert.equal(resized.info.height, 8);
    assert.equal(resized.data[3], 0, 'Padding should be transparent');

    const crop = await transform('Crop the image to 1x1 at x=0, y=0');
    assert.deepEqual([...crop.data], [255, 0, 0, 255]);
    const centered = await transform('Изрежи 1×1 в центъра');
    assert.deepEqual([...centered.data], [0, 255, 0, 255]);

    const rotated = await transform('Rotate the image by 90 degrees clockwise');
    assert.equal(rotated.info.width, 2);
    assert.equal(rotated.info.height, 3);
    assert.deepEqual([...rotated.data.subarray(0, 4)], [0, 255, 255, 255]);

    const grays = await transform('Направи снимката черно-бяла');
    for (let i = 0; i < grays.data.length; i += 4) {
      assert.equal(grays.data[i], grays.data[i + 1]);
      assert.equal(grays.data[i + 1], grays.data[i + 2]);
      assert.equal(grays.data[i + 3], 255);
    }

    const mirrored = await transform('Обърни хоризонтално');
    assert.deepEqual([...mirrored.data.subarray(0, 4)], [0, 0, 255, 255]);
    const flipped = await transform('Flip the image vertically');
    assert.deepEqual([...flipped.data.subarray(0, 4)], [0, 255, 255, 255]);

    const tonePixels = Buffer.from([120, 120, 120, 97, 110, 85, 50, 21, 90, 30, 125, 0]);
    const tonesFile = { ...file, data: await sharp(tonePixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer() };
    const originalTones = await saveUpload(tonesFile.data, file.mimeType, owner);
    const warmer = await transform('Направи цветовете по-топли', tonesFile);
    const cooler = await transform('Cool the colors', tonesFile);
    const reduced = await transform('Set saturation to 60%', tonesFile);
    const unchanged = await transform('Задай наситеността на 100%', tonesFile);
    const monochrome = await transform('Set saturation to 0%', tonesFile);
    for (const result of [warmer, cooler, reduced, unchanged, monochrome]) {
      assert.equal(result.info.width, 3);
      assert.equal(result.info.height, 1);
      assert.deepEqual([result.data[3], result.data[7], result.data[11]], [97, 21, 0]);
    }
    assert.deepEqual([...warmer.data.subarray(0, 4)], [129, 120, 110, 97]);
    assert.deepEqual([...cooler.data.subarray(0, 4)], [110, 120, 129, 97]);
    assert.ok(reduced.data[4] - reduced.data[6] < tonePixels[4] - tonePixels[6]);
    assert.deepEqual(unchanged.data, tonePixels);
    assert.equal(monochrome.data[4], monochrome.data[5]);
    assert.equal(monochrome.data[5], monochrome.data[6]);
    const storedTones = await readOwnedUpload(originalTones.id, owner);
    assert.ok(storedTones);
    assert.deepEqual(Buffer.from(storedTones.data), tonesFile.data);

    const sixteenBit = new Uint16Array([24000, 24000, 24000, 3401, 52000, 11500, 19000, 50500]);
    const sixteenFile = { ...file, data: await sharp(sixteenBit, { raw: { width: 2, height: 1, channels: 4 } }).toColourspace('rgb16').png().toBuffer() };
    for (const command of ['Warm the colors', 'Set saturation to 160%']) {
      const result = await transform(command, sixteenFile, 'ushort');
      const values = new Uint16Array(result.data.buffer, result.data.byteOffset, result.data.length / 2);
      assert.equal(result.info.width, 2);
      assert.equal(result.info.height, 1);
      assert.deepEqual([values[3], values[7]], [3401, 50500]);
      assert.notDeepEqual([...values], [...sixteenBit]);
    }
    await assert.rejects(() => runLocalImageEdit({ edit: { operation: 'saturation', percentage: 201 }, file, userId: owner }),
      (error: unknown) => error instanceof LocalImageEditError && error.status === 422);

    const cameraImage = await sharp(input).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const cameraCrop = await runLocalImageEdit({
      edit: { operation: 'crop', width: 2, height: 3 },
      file: { mimeType: 'image/jpeg', data: cameraImage }, userId: owner,
    });
    const cameraResult = await readOwnedUpload(cameraCrop.id, owner);
    assert.ok(cameraResult);
    const oriented = await sharp(cameraResult.data).metadata();
    assert.equal(oriented.width, 2);
    assert.equal(oriented.height, 3);
    assert.equal(oriented.orientation, undefined);

    await assert.rejects(() => runLocalImageEdit({ edit: { operation: 'crop', width: 900, height: 900 }, file, userId: owner }),
      (error: unknown) => error instanceof LocalImageEditError && error.status === 422);
    await assert.rejects(() => runLocalImageEdit({
      edit: { operation: 'grayscale' }, file: { ...file, data: Buffer.from('invalid png') }, userId: owner,
    }), (error: unknown) => error instanceof LocalImageEditError && error.status === 415);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(() => runLocalImageEdit({ edit: { operation: 'grayscale' }, file, userId: owner, signal: abort.signal }),
      { name: 'AbortError' });

    const unmodified = await readOwnedUpload(original.id, owner);
    assert.ok(unmodified);
    assert.deepEqual(Buffer.from(unmodified.data), input);
    console.log('Local image edits passed: original/owner isolation, resize/crop/rotate/flip, monochrome, warmth and saturation, 8-bit and 16-bit transparency, failure and cancellation.');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
