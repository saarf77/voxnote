// node --test test/pinned-language.test.mjs — a language the account set is kept: a transcript in
// another script is never delivered; the retries stay in that language. Fake provider, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.TRANSCRIBE_API_KEY = 'test-key';
process.env.TRANSCRIBE_BASE_URL = 'https://api.openai.com/v1';
process.env.TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
delete process.env.TRANSCRIBE_LANGUAGE;
const { transcribeRun } = await import('../src/transcribe.js');
const { checkTranscript } = await import('../src/sanity.js');

const dir = mkdtempSync(join(tmpdir(), 'voxnote-pinned-'));
const audio = join(dir, 'note.ogg'); writeFileSync(audio, Buffer.from('OggS fake'));
const HEBREW = 'אני מגיע בעוד עשר דקות, תחכו לי ליד הכניסה';
const ARABIC = 'انا جاي بعد عشر دقائق استنوني عند المدخل';
const validate = (text, ctx) => checkTranscript(text, { seconds: 4, language: ctx.language });

/** A fake provider: answers each call from the script, records what was asked. */
function fake(answers) {
  const calls = [];
  globalThis.fetch = async (_url, { body }) => {
    calls.push({ model: body.get('model'), language: body.get('language'), prompt: body.get('prompt') });
    return new Response(answers[calls.length - 1] ?? ARABIC, { status: 200 });
  };
  return calls;
}

test('Hebrew set by the owner, answered in Arabic: the hinted Hebrew retry is delivered, never auto-detect', async () => {
  const calls = fake([ARABIC, HEBREW]);
  const r = await transcribeRun({ absPath: audio, language: 'he', validate });
  assert.equal(r.text, HEBREW); assert.equal(r.check.ok, true); assert.equal(r.retry, 'hint');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.language === 'he'), 'every call keeps the language');
  assert.equal(calls[1].prompt, 'הודעה קולית בעברית.');
});

test('the second model answers when the hint did not help', async () => {
  const calls = fake([ARABIC, ARABIC, HEBREW]);
  const r = await transcribeRun({ absPath: audio, language: 'he', validate });
  assert.equal(r.text, HEBREW); assert.equal(r.retry, 'gpt-4o-mini-transcribe'); assert.equal(r.model, 'gpt-4o-mini-transcribe');
  assert.equal(calls[2].model, 'gpt-4o-mini-transcribe'); assert.equal(calls[2].language, 'he');
});

test('every attempt in another script: nothing passes, so nothing in a foreign script is delivered', async () => {
  const calls = fake([ARABIC, ARABIC, ARABIC]);
  const r = await transcribeRun({ absPath: audio, language: 'he', validate });
  assert.equal(r.check.ok, false);
  assert.match(r.check.reason, /wrong script.*hint: .*wrong script.*gpt-4o-mini-transcribe: .*wrong script/);
  assert.equal(calls.length, 3); assert.ok(calls.every((c) => c.language === 'he'));
});

test('an account on auto-detect is untouched: one call, whatever the language', async () => {
  const calls = fake([ARABIC]);
  const r = await transcribeRun({ absPath: audio, language: '', validate });
  assert.equal(r.text, ARABIC); assert.equal(r.check.ok, true); assert.equal(r.retry, null);
  assert.equal(calls.length, 1); assert.equal(calls[0].language, null);
});

test('a retry that only says the hint back (audio with no speech) is not a transcript', async () => {
  const calls = fake([ARABIC, 'הודעה קולית בעברית.', 'הודעה קולית בעברית']);
  const r = await transcribeRun({ absPath: audio, language: 'he', validate });
  assert.equal(r.check.ok, false); assert.match(r.check.reason, /repeated the hint/);
  assert.equal(calls.length, 3);
});
