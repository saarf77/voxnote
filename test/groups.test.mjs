// node --test test/groups.test.mjs — what happens in groups nobody switched: "groups off" (nothing; new
// accounts) or "groups mine" (the owner's own voice notes get their text). Invented chats throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-groups-'));
process.env.CLAIM_YIELD_MS = '5';
const { Tenant } = await import('../src/tenant.js');
const registry = await import('../src/registry.js');

const CONTROL = '999@g.us', CLUB = '555@g.us', FRIEND = '444@s.whatsapp.net';
let seq = 0;
function tenant(rec = {}) {
  const id = `g${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now(), manageKey: 'k'.repeat(32), ...rec }, join(process.env.DATA_DIR, id));
  t.target = { jid: CONTROL, name: 'Ramble' };
  t.out = []; t.worked = [];
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; };
  t.handleRecording = async (m, n) => { t.worked.push(`${n.fromMe ? 'mine' : 'theirs'}@${n.chatId}`); return true; };
  t.sock = {};
  return t;
}
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true };
const rec = (t, chatId, fromMe) => { const id = `V${++seq}`; return t.onMessage({ key: { remoteJid: chatId, fromMe, id, ...(chatId.endsWith('@g.us') && !fromMe ? { participant: '777@s.whatsapp.net' } : {}) }, pushName: 'Someone', message: { audioMessage: { ...node, fileSha256: Buffer.from(id) } } }, t.sock); };
const say = (t, body) => { const key = { remoteJid: CONTROL, fromMe: true, id: `T${++seq}` }; const message = { conversation: body }; return t.handleCommand({ key, message }, t.normalize({ key, message }), 'Ramble'); };

test('a new account starts with groups off; an account from before the setting keeps its own notes in groups', () => {
  const fresh = registry.create({ start: false });
  assert.equal(fresh.groups, 'off');
  assert.equal(tenant().groups, 'mine', 'no setting on record: what it had before');
});

test('groups off: nothing in a group, not mine and not theirs; private chats unchanged', async () => {
  const t = tenant({ groups: 'off' });
  await rec(t, CLUB, true); await rec(t, CLUB, false); await rec(t, FRIEND, true); await rec(t, FRIEND, false);
  assert.deepEqual(t.worked, [`mine@${FRIEND}`, `theirs@${FRIEND}`]);
});

test('groups mine: my own notes in every group not excluded; other people\'s only where included', async () => {
  const t = tenant({ groups: 'mine' });
  await rec(t, CLUB, true); await rec(t, CLUB, false);
  assert.deepEqual(t.worked, [`mine@${CLUB}`]);
  await t.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'exclude');
  t.worked.length = 0; await rec(t, CLUB, true);
  assert.deepEqual(t.worked, [], 'excluded: not even mine');
});

test('an included group transcribes everyone, whatever the setting', async () => {
  const t = tenant({ groups: 'off' });
  await t.applySwitch({ chatId: CLUB, ids: [CLUB], name: 'Book club', isGroup: true }, 'include');
  await rec(t, CLUB, true); await rec(t, CLUB, false);
  assert.deepEqual(t.worked, [`mine@${CLUB}`, `theirs@${CLUB}`]);
});

test('the command: groups shows, groups mine / groups off set and persist, anything else changes nothing', async () => {
  const t = tenant({ groups: 'off' });
  assert.equal(await say(t, 'groups'), true); assert.match(t.out.at(-1).text, /Nothing is transcribed in groups/); assert.match(t.out.at(-1).text, /\*groups mine\*/);
  assert.equal(await say(t, 'Groups Mine'), true); assert.equal(t.groups, 'mine'); assert.match(t.out.at(-1).text, /^👥 Done: In every group/);
  assert.equal(new Tenant({ id: t.id, createdAt: t.createdAt, manageKey: t.manageKey, groups: 'mine' }, t.dir).groups, 'mine');
  assert.equal(await say(t, 'groups everything'), true); assert.equal(t.groups, 'mine', 'an unknown value shows the setting, changes nothing');
  assert.equal(await say(t, 'groups off'), true); assert.equal(t.groups, 'off');
  assert.equal(t.chatMode(CLUB), 'off'); t.groups = 'mine'; assert.equal(t.chatMode(CLUB), 'mine'); assert.equal(t.chatMode(FRIEND), 'included');
});

test('Hebrew: every line of the new texts opens with a Hebrew letter', async () => {
  const t = tenant({ locale: 'he', groups: 'off' });
  await say(t, 'groups'); await say(t, 'groups mine'); await say(t, 'groups');
  const texts = [...t.out.map((o) => o.text), t.welcomeText(), t.helpText()];
  for (const line of texts.flatMap((x) => x.split('\n')).filter((l) => l.trim())) { const first = line.match(/\p{L}/u)?.[0]; if (first) assert.match(first, /[֐-׿]/, line); }
});
