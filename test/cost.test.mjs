// node --test test/cost.test.mjs — what a recording costs: minutes of speech, tokens of chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meter, bill, chargeSpeech, chargeChat } from '../src/cost.js';

test('a recording is billed for each transcription by the minute and each chat call by the tokens it used', async () => {
  const b = await meter(90, async () => {
    chargeSpeech('gpt-4o-transcribe');                                                   // 1.5 min × $0.006
    await Promise.resolve();                                                             // still the same recording after an await
    chargeChat('gpt-5.4-mini', { prompt_tokens: 2000, completion_tokens: 1000 });       // $0.0015 + $0.0045
    return bill();
  });
  assert.ok(Math.abs(b.usd - 0.015) < 1e-9);
  assert.equal(b.unpriced, false);
});

test('an unknown model is billed at the dearer rate and marks the bill an estimate; nothing is billed outside a recording', async () => {
  const b = await meter(60, async () => { chargeSpeech('some-new-model'); return bill(); });
  assert.equal(b.unpriced, true); assert.ok(b.usd > 0);
  chargeSpeech('gpt-4o-transcribe'); assert.equal(bill(), null);
});
