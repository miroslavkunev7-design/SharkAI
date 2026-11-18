import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { applySunsetLighting, describeLocalImageEdit, localImageEditMode, wantsSunsetLighting } from '../lib/local-image.server';

test('preserves the requested scene, prioritizes lighting, and avoids depicting a physical book', () => {
  assert.equal(
    describeLocalImageEdit('Edit the image: Make the same mountain lake at vivid orange sunset, watercolor book illustration, snowy Alps reflected in water.'),
    'vivid orange sunset, mountain lake, watercolor illustration, snowy Alps reflected in water.',
  );
  assert.equal(describeLocalImageEdit('Please, edit the picture: a spiral-bound sketchbook with a watercolor book illustration.'),
    'a spiral-bound sketchbook with a watercolor book illustration.');
  assert.equal(describeLocalImageEdit('Редактирай снимката: акварелна илюстрация за книга с планинско езеро.'),
    'акварелна илюстрация с планинско езеро.');
});

test('uses a composition-preserving option unless a broader reinterpretation was requested', () => {
  assert.equal(localImageEditMode('Change the light to warm sunset.'), 'preserve');
  assert.equal(localImageEditMode('Redraw this photo as a surreal oil painting.'), 'transform');
  assert.equal(localImageEditMode('Redraw this photo but keep the same composition.'), 'preserve');
  assert.equal(localImageEditMode('Превърни снимката в комикс.'), 'transform');
  assert.equal(localImageEditMode('Прерисувай снимката, запази композицията.'), 'preserve');
});

test('applies warm sunset colors only on an explicit compatible edit and retains the frame', async () => {
  assert.equal(wantsSunsetLighting('Make the same mountain lake at vivid orange sunset.'), true);
  assert.equal(wantsSunsetLighting('Покажи същото езеро при оранжев залез.'), true);
  assert.equal(wantsSunsetLighting('Keep the cool tones, without an orange sunset.'), false);
  assert.equal(wantsSunsetLighting('Redraw this photo as a painting at warm sunset.'), false);
  const source = Buffer.from([65, 140, 210, 212, 26, 101, 79, 126, 240, 240, 240, 255]);
  const png = await sharp(source, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const result = await sharp(await applySunsetLighting(png)).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 3);
  assert.equal(result.info.height, 1);
  assert.equal(result.data[3], 212);
  assert.ok(result.data[0] > result.data[1] && result.data[1] > result.data[2]);
  assert.deepEqual(result.data.subarray(4), source.subarray(4));
});
