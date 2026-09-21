// node --test test/rewrite.test.mjs  (pure guard tests, no network)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRewrite, splitHeadline, buildRewriteInput } from '../src/rewrite.js';
import { acceptHeadline } from '../src/summarize.js';

const input = 'היי רציתי לעדכן לגבי הפגישה של מחר חדר הישיבות בקומה שלוש תפוס עד עשר אז נתחיל בעשר וחצי תביאו את המצגת של הרבעון ואת רשימת הלקוחות החדשים אם מישהו לא יכול להגיע שיכתוב לי עד הערב ונמצא מועד אחר חוץ מזה המדפסת בקומה שתיים שוב תקועה אז תדפיסו למטה תודה ונדבר מחר';

test('a rewrite of similar length is accepted, quotes and bold stripped', () => {
  const out = '"היי, רציתי לעדכן לגבי הפגישה של מחר. חדר הישיבות בקומה שלוש תפוס עד עשר, אז נתחיל בעשר וחצי. תביאו את המצגת של הרבעון ואת רשימת הלקוחות החדשים. אם מישהו לא יכול להגיע, שיכתוב לי עד הערב ונמצא מועד אחר. חוץ מזה, המדפסת בקומה שתיים שוב תקועה, אז תדפיסו למטה. תודה ונדבר מחר."';
  const r = acceptRewrite(input, out);
  assert.equal(r.ok, true);
  assert.ok(!r.text.startsWith('"') && !r.text.includes('*'));
});

test('a much shorter message that kept the content is accepted', () => {
  const r = acceptRewrite(input, 'הפגישה מחר נדחית לעשר וחצי כי החדר בקומה שלוש תפוס. תביאו את מצגת הרבעון ואת רשימת הלקוחות החדשים. מי שלא יכול, שיכתוב לי עד הערב. המדפסת בקומה שתיים תקועה, תדפיסו למטה.');
  assert.equal(r.ok, true);
});

test('a stub out of a long note is rejected: content was lost', () => {
  const r = acceptRewrite(input, 'הפגישה מחר בעשר וחצי.');
  assert.equal(r.ok, false);
  assert.match(r.reason, /too short/);
});

test('a four-word note may stay four words', () => {
  assert.equal(acceptRewrite('אני כבר בדרך אליך', 'אני כבר בדרך אליך.').ok, true);
});

test('an inflated result is rejected', () => {
  const r = acceptRewrite(input, (input + ' ').repeat(3));
  assert.equal(r.ok, false);
  assert.match(r.reason, /too long/);
});

test('switching language is rejected', () => {
  const r = acceptRewrite(input, 'Hi, an update about tomorrow\'s meeting. The meeting room on the third floor is taken until ten, so we will start at half past ten. Bring the quarterly deck and the list of new clients. If anyone cannot make it, write to me by tonight and we will find another time. Also, the printer on the second floor is stuck again, so print downstairs. Thanks, talk tomorrow.');
  assert.equal(r.ok, false);
  assert.match(r.reason, /script/);
});

test('chatty preamble is rejected', () => {
  const r = acceptRewrite(input, 'הנה הגרסה המשוכתבת: ' + input);
  assert.equal(r.ok, false);
});

test('empty is rejected', () => {
  assert.equal(acceptRewrite(input, '  ').ok, false);
});

test('the headline is split from the message; a reply without one is all message', () => {
  assert.deepEqual(splitHeadline('החדר תפוס עד עשר.\nתביאו את המצגת.\n\nHEADLINE: הפגישה נדחית לעשר וחצי'), { headline: 'הפגישה נדחית לעשר וחצי', body: 'החדר תפוס עד עשר.\nתביאו את המצגת.' });
  assert.deepEqual(splitHeadline('החדר תפוס עד עשר.'), { headline: null, body: 'החדר תפוס עד עשר.' });
});

test('the headline is asked for in the user message, so the system prompt stays cacheable', () => {
  assert.match(buildRewriteInput('שלום', { headline: true }), /Headline: yes, about 12 words/);
  assert.match(buildRewriteInput(Array(400).fill('מילה').join(' '), { headline: true }), /about 45 words/);
  assert.match(buildRewriteInput('שלום', { headline: false }), /Headline: no/);
});

test('a headline may run to a few sentences for a long note, but not to a paragraph or report-speak', () => {
  assert.equal(acceptHeadline('אל-על: תפנה לווטסאפ הרשמי, אין בעיה. גדר: לאורך טרסת הבטון ליד המדרגות למרתף. ומה זה "הרשאות גוגל" מספר 2?').ok, true);
  assert.equal(acceptHeadline(Array(70).fill('מילה').join(' ')).ok, false);
  assert.equal(acceptHeadline('שורה אחת\nושורה שנייה').ok, false);
  assert.equal(acceptHeadline('אני מתאר את ההרדמות של היום').ok, false);
});

test('the faithful style keeps its own guard: a much shorter result is a summary, and is refused', () => {
  const short = 'הפגישה מחר נדחית לעשר וחצי כי החדר בקומה שלוש תפוס. תביאו את מצגת הרבעון.';
  assert.equal(acceptRewrite(input, short).ok, true);
  assert.equal(acceptRewrite(input, short, { style: 'faithful' }).ok, false);
});

test('the faithful rewrite is not asked about a headline at all', () => {
  assert.doesNotMatch(buildRewriteInput('שלום', { headline: null }), /Headline/);
});
