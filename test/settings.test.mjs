// node --test test/settings.test.mjs — the settings page: what is transcribed, whose, and where the text
// goes, by kind of chat; the page and its API; the "settings" command's link. Invented chats throughout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'voxnote-settings-'));
process.env.CLAIM_YIELD_MS = '5';
process.env.TRUST_PROXY = '0';
process.env.GITHUB_STARS = 'off';
process.env.PUBLIC_URL = 'https://voxnote.example';
const S = await import('../src/settings.js');
const { Tenant } = await import('../src/tenant.js');
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');

const CONTROL = '999@g.us', CLUB = '555@g.us', FAMILY = '556@g.us', RON = '444@s.whatsapp.net', RON_LID = '88888@lid', DANA = '445@s.whatsapp.net';
let seq = 0;
function tenant(rec = {}) {
  const id = `st${++seq}`;
  const t = new Tenant({ id, createdAt: Date.now(), manageKey: 'k'.repeat(32), ...rec }, join(process.env.DATA_DIR, id));
  t.target = { jid: CONTROL, name: 'VoxNote' };
  t.out = []; t.worked = [];
  t.sendPaced = async (jid, content) => { t.out.push({ jid, ...content }); return { key: { id: `S${++seq}` } }; };
  t.handleRecording = async (m, n) => { t.worked.push(`${n.fromMe ? 'mine' : 'theirs'}@${n.chatId}>${n.route}`); return true; };
  t.sock = {};
  return t;
}
const node = { mediaKey: 'AAAA', directPath: '/v/t62.7117-24/abc.enc?ccb=11-4&oh=x', url: 'https://mmg.whatsapp.net/v/t62.7117-24/abc.enc', fileLength: 1200, seconds: 30, ptt: true };
const rec = (t, chatId, fromMe, alt) => { const id = `V${++seq}`; return t.onMessage({ key: { remoteJid: chatId, fromMe, id, ...(alt ? { remoteJidAlt: alt } : {}), ...(chatId.endsWith('@g.us') && !fromMe ? { participant: '777@s.whatsapp.net' } : {}) }, pushName: 'Someone', message: { audioMessage: { ...node, fileSha256: Buffer.from(id) } } }, t.sock); };
const say = (t, body) => { const key = { remoteJid: CONTROL, fromMe: true, id: `T${++seq}` }; const message = { conversation: body }; return t.handleCommand({ key, message }, t.normalize({ key, message }), 'VoxNote'); };
/** Every case at once: my note and theirs, in a private chat and a group. */
async function matrix(t) {
  t.worked = [];
  for (const [chat, fromMe] of [[RON, true], [RON, false], [CLUB, true], [CLUB, false]]) await rec(t, chat, fromMe);
  return t.worked;
}

test('a change is checked field by field: unknown values and ids that are not chats are dropped', () => {
  const s = S.applyPatch(S.defaults(), { where: 'me', chats: { on: 'yes', who: 'nobody', some: [RON, 'x@evil', '<b>@lid', RON, CLUB] }, groups: { on: false, some: [CLUB, RON] }, extra: 1 });
  assert.deepEqual(s.chats, { on: true, who: 'all', where: 'me', some: [RON] });
  assert.deepEqual(s.groups, { on: false, who: 'mine', where: 'me', some: [CLUB] });
  assert.equal(S.whereOf(s), 'me');
  assert.equal(S.whereOf(S.applyPatch(s, { chats: { where: 'chat' } })), 'mixed');
  assert.equal(S.applyPatch(S.defaults(), { chats: { some: Array.from({ length: 400 }, (_, i) => `${10000 + i}@s.whatsapp.net`) } }).chats.some.length, 300);
});

test('an account from before the page keeps what its groups setting meant', () => {
  assert.deepEqual(S.fromLegacy('off').groups, { on: false, who: 'mine', where: 'chat', some: [] });
  assert.deepEqual(S.fromLegacy('mine').groups, { on: true, who: 'mine', where: 'chat', some: [] });
  assert.deepEqual(S.fromLegacy('private').groups, { on: true, who: 'all', where: 'me', some: [] });
  assert.deepEqual(S.fromLegacy(undefined), S.defaults());
  for (const g of ['off', 'mine', 'private']) assert.equal(S.legacyGroups(S.fromLegacy(g)), g, 'and writes it back the same, for a server from before');
});

test('the defaults: everyone\'s voice notes in private chats, my own in groups, all in the chat', async () => {
  assert.deepEqual(await matrix(tenant({ settings: S.defaults() })), [`mine@${RON}>chat`, `theirs@${RON}>chat`, `mine@${CLUB}>chat`]);
});

test('only to me: everyone\'s voice notes, in private chats and groups, and every text comes to the control group', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { where: 'me' }) });
  assert.deepEqual(await matrix(t), [`mine@${RON}>me`, `theirs@${RON}>me`, `mine@${CLUB}>me`, `theirs@${CLUB}>me`]);
});

test('a section switched off is silent, mine and theirs; the other one carries on', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { on: false }, groups: { who: 'all' } }) });
  assert.deepEqual(await matrix(t), [`mine@${CLUB}>chat`, `theirs@${CLUB}>chat`]);
  await t.updateSettings({ groups: { on: false } });
  assert.deepEqual(await matrix(t), []);
});

test('picked chats: only those, under either of a person\'s ids; Notes to self is never left out', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { some: [RON] }, groups: { some: [FAMILY] } }) });
  t.ownId = '972500000000@s.whatsapp.net';
  assert.deepEqual(await matrix(t), [`mine@${RON}>chat`, `theirs@${RON}>chat`], 'Ron is picked; the book club is not');
  t.worked = []; await rec(t, RON_LID, false, RON); await rec(t, DANA, false); await rec(t, FAMILY, true); await rec(t, t.ownId, true);
  assert.deepEqual(t.worked, [`theirs@${RON_LID}>chat`, `mine@${FAMILY}>chat`, `mine@${t.ownId}>chat`]);
});

test('the switches from WhatsApp still win: excluded is silent, included is everyone\'s in the chat, private comes to me', async () => {
  const t = tenant({ settings: S.applyPatch(S.defaults(), { chats: { some: [DANA] } }) });
  t.muted.add(DANA); t.enabled.add(RON); t.quiet.add(CLUB);
  t.worked = []; await rec(t, DANA, true); await rec(t, RON, false); await rec(t, CLUB, false);
  assert.deepEqual(t.worked, [`theirs@${RON}>chat`, `theirs@${CLUB}>me`]);
});

test('choosing "only to me" on the page moves the chats included from WhatsApp to private mode, so nothing is posted', async () => {
  const t = tenant(); t.enabled.add(CLUB); t.enabled.add(RON);
  const view = await t.updateSettings({ where: 'me' });
  assert.equal(view.where, 'me');
  assert.equal(t.enabled.size, 0); assert.ok(t.quiet.has(CLUB) && t.quiet.has(RON));
  assert.deepEqual(await matrix(t), [`mine@${RON}>me`, `theirs@${RON}>me`, `mine@${CLUB}>me`, `theirs@${CLUB}>me`]);
  const back = new Tenant(JSON.parse(readFileSync(join(t.dir, 'tenant.json'), 'utf8')), t.dir);
  assert.equal(S.whereOf(back.settings), 'me', 'saved with the account');
});

test('the groups command speaks the same model: off, mine, all, private', async () => {
  const t = tenant();
  for (const [word, want] of [['groups all', { on: true, who: 'all', where: 'chat' }], ['groups private', { on: true, who: 'all', where: 'me' }], ['groups off', { on: false }], ['groups mine', { on: true, who: 'mine', where: 'chat' }]]) {
    assert.equal(await say(t, word), true);
    for (const [k, v] of Object.entries(want)) assert.equal(t.settings.groups[k], v, `${word}: ${k}`);
  }
  await t.updateSettings({ groups: { some: [CLUB] } });
  await say(t, 'groups');
  assert.match(t.out.at(-1).text, /Only in the groups you picked/);
  assert.match(t.out.at(-1).text, /\*groups all\*/);
});

test('the settings command sends a link that signs in for a day, in the owner\'s language', async () => {
  const t = tenant();
  assert.equal(await say(t, 'settings'), true);
  const url = /https:\/\/voxnote\.example\/settings\/(\w+)\?t=([\w.-]+)/.exec(t.out.at(-1).text);
  assert.ok(url, t.out.at(-1).text);
  assert.equal(url[1], t.id);
  assert.equal(S.checkSettingsToken(t.id, t.manageKey, url[2]), true);
  assert.equal(S.checkSettingsToken(t.id, t.manageKey, url[2], Date.now() + S.SETTINGS_LINK_TTL_MS + 60e3), false, 'expired after a day');
  assert.equal(S.checkSettingsToken(t.id, 'j'.repeat(32), url[2]), false, 'another key');
  assert.equal(S.checkSettingsToken('other', t.manageKey, url[2]), false, 'another account');
  assert.equal(S.checkSettingsToken(t.id, t.manageKey, `${url[2].split('.')[0]}.${'A'.repeat(32)}`), false, 'forged');
  t.locale = 'he'; await say(t, 'settings');
  for (const line of t.out.at(-1).text.split('\n')) assert.match(line.match(/\p{L}/u)[0], /[֐-׿]/, line);
  assert.match(t.helpText(), /\*settings\*/); assert.match(t.welcomeText(), /\*settings\*/);
});

// ---------- the page ----------
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const HE = 'he-IL,he;q=0.9', EN = 'en-US,en;q=0.9';
function linked() {
  const t = registry.create({ start: false });
  t.linkedAt = Date.now();
  t.contactNames = new Map([[RON, 'Ron Levi'], [DANA, 'Dana'], [RON_LID, 'Ron Levi']]); t.altIds = new Map([[RON, RON_LID], [RON_LID, RON]]);
  t.savedNames = new Set([RON]); t.groupNames = new Map([[CLUB, 'Book club'], [CONTROL, 'VoxNote']]); t.target = { jid: CONTROL, name: 'VoxNote' };
  return { t, cookie: `rl=${t.id}.${t.manageKey}` };
}

test('the link from the command becomes a session and leaves the address bar; a bad or old one is refused', async () => {
  const { t } = linked();
  const r = await fetch(`${base}/settings/${t.id}?t=${S.settingsToken(t.id, t.manageKey)}`, { redirect: 'manual' });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/settings/${t.id}`);
  assert.match(r.headers.get('set-cookie'), new RegExp(`^rl=${t.id}\\.${t.manageKey};.*HttpOnly`));
  for (const bad of [S.settingsToken(t.id, t.manageKey, Date.now() - 2 * S.SETTINGS_LINK_TTL_MS), 'nope', S.settingsToken(t.id, 'j'.repeat(32))]) {
    const x = await fetch(`${base}/settings/${t.id}?t=${bad}`, { redirect: 'manual' });
    assert.equal(x.status, 404); assert.equal(x.headers.get('set-cookie'), null);
  }
  assert.equal((await fetch(`${base}/settings/${t.id}`, { redirect: 'manual' })).status, 404, 'no session, no page');
});

test('the page draws in both languages from the same strings; the welcome only right after linking', async () => {
  const { t, cookie } = linked();
  const get = async (q, al) => (await fetch(`${base}/settings/${t.id}${q}`, { headers: { cookie, 'accept-language': al } })).text();
  const table = (html) => JSON.parse(/const S=(\{.*?\});const P=/s.exec(html)[1]);
  const he = await get('', HE), en = await get('?welcome=1', EN);
  assert.match(he, /dir="rtl"/); assert.match(he, /no-store|VoxNote/);
  const keys = (o) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
  assert.deepEqual(keys(table(he)), keys(table(en)), 'a string added in one language must exist in the other');
  for (const [k, v] of Object.entries(table(he))) if (typeof v === 'string') assert.match(v, /[֐-׿]/, `${k} is Hebrew`);
  assert.ok(!/הקלטות/.test(JSON.stringify(table(he))), 'voice notes, never recordings');
  assert.match(en, /id="toast"/); assert.ok(!/id="toast"/.test(he));
  assert.match(en, /id="cta"/, 'before the first voice note, the page leads into WhatsApp');
  t.firstNoteAt = Date.now();
  assert.ok(!/id="cta"/.test(await get('', EN)), 'after it, the settings stand alone');
  assert.ok(!/style="/.test(en), 'no inline styles: the CSP allows none');
});

test('the API: reads and saves the settings, refuses strangers and other sites, lists chats with names', async () => {
  const { t, cookie } = linked();
  const api = (path, opts = {}) => fetch(`${base}/api/settings/${t.id}${path}`, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
  const view = await (await api('')).json();
  assert.equal(view.where, 'chat'); assert.equal(view.groups.who, 'mine');
  const post = (body, headers = {}) => api('', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  const saved = await (await post({ where: 'me', chats: { some: [RON_LID, 'bogus'] } })).json();
  assert.equal(saved.where, 'me'); assert.deepEqual(saved.chats.some, [{ id: RON_LID, name: 'Ron Levi' }]);
  assert.equal(t.settings.chats.where, 'me');
  assert.equal((await post({ where: 'chat' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(t.settings.chats.where, 'me', 'nothing changed');
  assert.equal((await fetch(`${base}/api/settings/${t.id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' })).status, 404, 'no session');
  const people = (await (await api('/chats?kind=chats')).json()).rows;
  assert.deepEqual(people.map((r) => r.slice(0, 2)), [[RON, 'Ron Levi'], [DANA, 'Dana']], 'one row per person, the phone id over the lid');
  const groups = (await (await api('/chats?kind=groups')).json()).rows;
  assert.deepEqual(groups.map((r) => r[1]), ['Book club'], 'never the control group');
});

test('the link page hands over to the settings page once linked', async () => {
  const { t, cookie } = linked();
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.match(html, new RegExp(`location\\.replace\\('/settings/${t.id}'`));
});

test('the button\'s group link exists only once joining needs approval; refused approval means no link', async () => {
  const calls = [];
  const t = tenant(); t.ready = true;
  t.sock = { groupJoinApprovalMode: async (jid, mode) => { calls.push(`approval ${mode}`); }, groupInviteCode: async () => { calls.push('invite'); return 'AbCdEf123'; } };
  const [a, b] = await Promise.all([t.groupLink(), t.groupLink()]);
  assert.equal(a, 'https://chat.whatsapp.com/AbCdEf123'); assert.equal(b, a);
  assert.deepEqual(calls, ['approval on', 'invite'], 'approval first, and once for two callers');
  assert.equal(await t.groupLink(), a); assert.equal(calls.length, 2, 'kept: WhatsApp is not asked again');
  assert.equal(t.settingsView().groupLink, a);
  const u = tenant(); u.ready = true; let invited = false;
  u.sock = { groupJoinApprovalMode: async () => { throw new Error('not allowed'); }, groupInviteCode: async () => { invited = true; return 'X'; } };
  assert.equal(await u.groupLink(), null); assert.equal(invited, false);
});

test('a new control group is pinned, and tried again when WhatsApp is not ready for it yet', async () => {
  const t = tenant(); let tries = 0;
  t.sock = { chatModify: async (mod, jid) => { tries++; assert.deepEqual([mod, jid], [{ pin: true }, CONTROL]); if (tries < 2) throw new Error('myAppStateKey not present'); } };
  t.pinControlGroup([10, 10]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tries, 2); assert.ok(t.target.pinned);
  t.pinControlGroup([10]); await new Promise((r) => setTimeout(r, 20)); assert.equal(tries, 2, 'pinned once');
});
