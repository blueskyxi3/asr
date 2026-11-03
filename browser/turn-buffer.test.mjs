import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnBuffer, wave } from './turn-buffer.mjs';
import { isDismiss } from './commands.mjs';

test('short pauses remain in one turn; a 1.2s pause ends exactly once', () => {
  const turn = new TurnBuffer(1200);
  const speech = new Float32Array(1600).fill(0.05), silence = new Float32Array(1600);
  for (let n = 0; n < 5; n++) assert.equal(turn.push(speech, true), null);
  for (let n = 0; n < 8; n++) assert.equal(turn.push(silence, false), null);
  assert.equal(turn.push(speech, true), null);
  for (let n = 0; n < 11; n++) assert.equal(turn.push(silence, false), null);
  const audio = turn.push(silence, false);
  assert.equal(audio.length, 26 * 1600);
  assert.equal(turn.push(silence, false), null);
  const wav = wave(audio); const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16);
});
test('silence is bounded; VAD ending confirmation does not add another half second', () => {
  const turn = new TurnBuffer(1200);
  const samples = new Float32Array(1600);
  for (let n = 0; n < 1000; n++) assert.equal(turn.push(samples, false), null);
  assert.ok(turn.length <= 9600);
  turn.push(samples, true); turn.ended(8000);
  for (let n = 0; n < 6; n++) assert.equal(turn.push(samples, false), null);
  assert.ok(turn.push(samples, false));
});
test('a partial final capture block cannot exceed the 120 second service limit', () => {
  const turn = new TurnBuffer(1200); const samples = new Float32Array(512);
  let result;
  for (let n = 0; n < 3750; n++) result = turn.push(samples, true);
  assert.equal(result.length, 120 * 16000);
  const oddBlocks = new TurnBuffer(1200, 1);
  for (let n = 0; n < 32; n++) result = oddBlocks.push(samples, true);
  assert.equal(result.length, 16000);
});
test('dismissal normalizes punctuation and accepts complete toneless Chinese homophones', () => {
  assert.equal(isDismiss('好的，你推下吧！', ['退下吧']), true);
  assert.equal(isDismiss('退一下吧', ['退一下吧']), true);
  assert.equal(isDismiss('你退', ['退下吧']), false);
  assert.equal(isDismiss('明天天气如何', ['退下吧']), false);
  assert.equal(isDismiss('好', ['号']), false);
  assert.equal(isDismiss('退下吧', []), false);
});
