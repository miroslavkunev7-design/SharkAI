import assert from 'node:assert/strict';
import test from 'node:test';
import { detectedUploadMime, mimeFromExt, resolveUploadMime, validateUpload } from '../lib/uploads';

function ebmlElement(id: string, payload: Buffer) {
  assert.ok(payload.length < 127);
  return Buffer.concat([Buffer.from(id, 'hex'), Buffer.of(128 + payload.length), payload]);
}

function webm(kinds: number[]) {
  const header = ebmlElement('1a45dfa3', ebmlElement('4282', Buffer.from('webm')));
  const entries = Buffer.concat(kinds.map((type) => ebmlElement('ae', ebmlElement('83', Buffer.of(type)))));
  const tracks = ebmlElement('1654ae6b', entries);
  // MediaRecorder may emit a Segment with unknown size.
  const segment = Buffer.from('1853806701ffffffffffffff', 'hex');
  return Buffer.concat([header, segment, tracks]);
}

function box(type: string, payload: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function mp4(kinds: string[]) {
  const tracks = kinds.map((kind) => box('trak', box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(kind)])))));
  return Buffer.concat([box('ftyp', Buffer.from('M4A ')), box('moov', Buffer.concat(tracks))]);
}

function oggPage(codec: string) {
  const header = Buffer.alloc(28);
  header.write('OggS');
  header[5] = 2;
  header[26] = 1;
  header[27] = codec.length;
  return Buffer.concat([header, Buffer.from(codec)]);
}

function wav() {
  const output = Buffer.alloc(46);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16000, 24);
  output.writeUInt32LE(32000, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(2, 40);
  return output;
}

test('uses unambiguous audio defaults and keeps the shared video extensions', () => {
  assert.equal(resolveUploadMime('audio/webm; codecs=opus', 'recording.webm'), 'audio/webm');
  assert.equal(resolveUploadMime('audio/x-wav', 'recording.wav'), 'audio/wav');
  assert.equal(resolveUploadMime('audio/x-m4a', 'recording.m4a'), 'audio/mp4');
  assert.equal(resolveUploadMime('video/mp4', 'recording.m4a'), 'audio/mp4');
  assert.equal(resolveUploadMime('application/ogg', 'recording.ogg'), 'audio/ogg');
  assert.equal(resolveUploadMime('', 'recording.webm'), '');
  assert.equal(resolveUploadMime('', 'recording.mp4'), '');
  assert.equal(mimeFromExt('webm'), 'video/webm');
  assert.equal(mimeFromExt('mp4'), 'video/mp4');
  assert.equal(mimeFromExt('m4a'), 'audio/mp4');
});

test('reads WebM track types when a browser labels all WebM as video', () => {
  assert.equal(validateUpload(webm([2]), 'audio/webm'), true);
  assert.equal(detectedUploadMime(webm([2]), 'video/webm'), 'audio/webm');
  assert.equal(detectedUploadMime(webm([1]), 'video/webm'), 'video/webm');
  assert.equal(detectedUploadMime(webm([2, 1]), 'video/webm'), 'video/webm');
  assert.equal(validateUpload(webm([1, 2]), 'audio/webm'), false);
  const truncated = webm([2]).subarray(0, -1);
  assert.equal(validateUpload(truncated, 'audio/webm'), false);
  assert.equal(validateUpload(webm([1, 2]), 'video/webm'), true);
});

test('validates audio Mp4, Ogg, and WAV containers', () => {
  assert.equal(validateUpload(mp4(['soun']), 'audio/mp4'), true);
  assert.equal(validateUpload(mp4(['soun', 'vide']), 'audio/mp4'), false);
  assert.equal(validateUpload(mp4(['vide']), 'audio/mp4'), false);
  assert.equal(validateUpload(mp4(['soun']).subarray(0, -1), 'audio/mp4'), false);
  assert.equal(validateUpload(oggPage('OpusHead'), 'audio/ogg'), true);
  assert.equal(validateUpload(Buffer.concat([oggPage('OpusHead'), oggPage('\x80theora')]), 'audio/ogg'), false);
  assert.equal(validateUpload(wav(), 'audio/wav'), true);
  assert.equal(validateUpload(wav(), 'audio/x-wav'), true);
  assert.equal(validateUpload(wav().subarray(0, -1), 'audio/wav'), false);
});
