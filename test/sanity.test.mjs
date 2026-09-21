// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTranscript } from '../src/sanity.js';

const he = { language: 'he' };

test('real hallucination: gpt-4o German vaccine paragraph under forced Hebrew', () => {
  const text = 'Wissenschaftler haben die Wirkung der Impfung auf die Virusübertragung untersucht. Sie haben festgestellt, dass geimpfte Personen das Virus seltener übertragen als ungeimpfte.';
  const r = checkTranscript(text, he);
  assert.equal(r.ok, false);
});

test('real hallucination: whisper "תודה. תודה רבה. תודה. תודה."', () => {
  const r = checkTranscript('תודה. תודה רבה. תודה. תודה.', he);
  assert.equal(r.ok, false);
  assert.match(r.reason, /repeated filler/);
});

test('german text without a forced language is still caught by the phrase list', () => {
  const r = checkTranscript('Wissenschaftler haben die Wirkung der Impfung auf die Virusübertragung untersucht.', {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /known hallucination/);
});

test('legit long Hebrew note passes', () => {
  const text = 'היי, רציתי לעדכן לגבי הפגישה של מחר. חדר הישיבות בקומה שלוש תפוס עד עשר, אז נתחיל בעשר וחצי. תביאו את המצגת של הרבעון ואת רשימת הלקוחות החדשים. אם מישהו לא יכול להגיע, שיכתוב לי עד הערב ונמצא מועד אחר. חוץ מזה, המדפסת בקומה שתיים שוב תקועה, אז תדפיסו למטה. תודה ונדבר מחר.';
  assert.deepEqual(checkTranscript(text, { ...he, seconds: 50 }), { ok: true });
});

test('legit short Hebrew answers pass', () => {
  assert.equal(checkTranscript('כן, מגיע בעוד עשר דקות', { ...he, seconds: 3 }).ok, true);
  assert.equal(checkTranscript('כן', { ...he, seconds: 1 }).ok, true);
});

test('Hebrew with a few Latin brand names passes the script check', () => {
  assert.equal(checkTranscript('שלחתי לך את הלינק ל-Railway ול-GitHub, תסתכל', he).ok, true);
});

test('more words than the duration allows is rejected', () => {
  const text = 'מילה '.repeat(60) + 'אחרת שונה נוספת חדשה';
  assert.equal(checkTranscript(text, { ...he, seconds: 2 }).ok, false);
});

test('long silence that yields a single word is rejected', () => {
  assert.equal(checkTranscript('תודה', { ...he, seconds: 9 }).ok, false);
});

test('empty is rejected', () => {
  assert.equal(checkTranscript('', he).ok, false);
  assert.equal(checkTranscript('   ', he).ok, false);
});

test('no forced language: only phrase, repetition and rate rules apply', () => {
  assert.equal(checkTranscript('Hello, are we still on for tomorrow at five?', { seconds: 4 }).ok, true);
  assert.equal(checkTranscript('thank you thank you thank you thank you', { seconds: 4 }).ok, false);
});
