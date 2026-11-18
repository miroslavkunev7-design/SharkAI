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

    async function transform(prompt: string) {
      const edit = parseLocalImageEdit(prompt);
      assert.ok(edit, `Unrecognized edit: ${prompt}`);
      const artifact = await runLocalImageEdit({ edit, file, userId: owner });
      assert.notEqual(artifact.id, original.id);
      assert.equal(artifact.url, `/api/upload/${artifact.id}`);
      assert.equal(await readOwnedUpload(artifact.id, otherOwner), null);
      const stored = await readOwnedUpload(artifact.id, owner);
      assert.ok(stored);
      assert.equal(stored.mimeType, 'image/png');
      return sharp(stored.data).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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
    console.log('Local image edits passed: exact PNG output, source pixels, resize, crop, rotate, monochrome, flips, isolation, failure and cancellation.');
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
