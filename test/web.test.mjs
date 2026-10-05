// node --test test/web.test.mjs — HTTP-level checks against the real app (no WhatsApp socket).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-web-'));
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TRUST_PROXY = '0';
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const t = registry.create({ language: 'he', start: false });
t.target = { jid: '1@g.us', name: '<img src=x onerror="document.body.dataset.x=1">' }; // hostile control-group name
t.mode = 'connected'; t.ready = true;

test('security headers on every response; private pages are no-store', async () => {
  const r = await fetch(`${base}/`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-/); assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  const p = await fetch(`${base}/link/${t.id}?k=${t.manageKey}`, { redirect: 'manual' });
  assert.equal(p.headers.get('cache-control'), 'no-store');
});

test('the private key is exchanged for an HttpOnly cookie and stripped from the URL', async () => {
  const r = await fetch(`${base}/link/${t.id}?k=${t.manageKey}`, { redirect: 'manual' });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/link/${t.id}`);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^rl=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  const page = await fetch(`${base}/link/${t.id}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  const api = await fetch(`${base}/api/link/${t.id}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(api.status, 200);
  assert.equal((await fetch(`${base}/link/${t.id}`)).status, 404, 'no cookie, no key → not found');
});

test('a hostile control-group name is escaped, never executed', async () => {
  const cookie = `rl=${t.id}.${t.manageKey}`;
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.ok(!html.includes('<img src=x onerror'), 'raw name must not appear in the HTML');
  const json = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(json.controlGroup, t.target.name, 'the API returns it as data; the page escapes it in JS');
  assert.match(html, /const esc=s=>/, 'page script escapes dynamic values');
});

test('wrong, malformed and multi-byte keys are rejected cleanly (404, never 500)', async () => {
  for (const k of ['nope', 'ה'.repeat(32), 'z'.repeat(32), '', '%00', 'A'.repeat(31)]) {
    const r = await fetch(`${base}/link/${t.id}?k=${encodeURIComponent(k)}`, { redirect: 'manual' });
    assert.equal(r.status, 404, `key ${JSON.stringify(k)}`);
  }
  assert.equal((await fetch(`${base}/link/../etc/passwd?k=${t.manageKey}`)).status, 404);
});

test('rotating the key invalidates the old link', async () => {
  const old = t.manageKey;
  const r = await fetch(`${base}/admin/link/${t.id}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: base } });
  assert.equal(r.status, 200);
  assert.match((await r.json()).link, new RegExp(`/link/${t.id}\\?k=${t.manageKey}$`));
  assert.notEqual(t.manageKey, old);
  assert.equal((await fetch(`${base}/link/${t.id}?k=${old}`, { redirect: 'manual' })).status, 404);
});

test('cross-site POSTs are refused, same-site ones pass', async () => {
  const cookie = `rl=${t.id}.${t.manageKey}`;
  const cross = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(cross.status, 403);
  const fetchSite = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(fetchSite.status, 403);
  const same = await fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'phone=15550100001', redirect: 'manual' });
  assert.equal(same.status, 303); assert.equal(t.pairPhone, '15550100001');
  // A browser that withholds the origin sends "Origin: null": our own form still goes through, a foreign one does not.
  const post = (h) => fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: 'null', 'content-type': 'application/x-www-form-urlencoded', ...h }, body: 'phone=15550100002', redirect: 'manual' });
  assert.equal((await post({ 'sec-fetch-site': 'same-origin' })).status, 303); assert.equal(t.pairPhone, '15550100002'); t.usePairingQr();
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({})).status, 403, 'a null origin with nothing to vouch for it is refused');
  const adminCross = await fetch(`${base}/admin/link/${t.id}`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), origin: 'https://evil.example' } });
  assert.equal(adminCross.status, 403);
});

test('admin: one card per account shows who it is (WhatsApp name, number); names are escaped', async () => {
  t.phone = '15550100009'; t.waName = '<img src=x onerror=alert(1)>Dana'; t.linkedAt = Date.now();
  const html = await (await fetch(`${base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  assert.match(html, new RegExp(`id="a-${t.id}"`));
  assert.match(html, /href="https:\/\/wa\.me\/15550100009"/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;Dana') && !html.includes('<img src=x onerror'));
  assert.ok(!html.includes('<table'), 'no wide table to scroll sideways');
  assert.match(html, /<b>0<\/b> recordings<br><span class="muted">0 theirs · 0 from others/);
  assert.ok(!/ style="/.test(html), 'no inline style attributes: the CSP would drop them');
  const j = await (await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).json();
  assert.equal(j.tenants.find((x) => x.id === t.id).phone, '15550100009');
  assert.ok(!('phone' in t.status()), 'the owner-facing status contract is unchanged');
  t.phone = ''; t.waName = ''; t.linkedAt = 0;
});

test('a sign-up records where it came from (country, device, source, returning browser); admin shows it in one line', async () => {
  const first = await fetch(`${base}/`);
  const rv = /rv=([0-9a-f]{20})/.exec(first.headers.get('set-cookie') || '')?.[1];
  assert.ok(rv, 'a public page gives the browser an anonymous id');
  const again = await fetch(`${base}/how`, { headers: { cookie: `rv=${rv}` } });
  assert.ok(!/rv=/.test(again.headers.get('set-cookie') || ''), 'a known browser keeps its id');
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const r = await fetch(`${base}/start`, { method: 'POST', redirect: 'manual', headers: { origin: base, cookie: `rv=${rv}`, 'user-agent': ua, 'accept-language': 'he-IL,he;q=0.9', 'content-type': 'application/x-www-form-urlencoded' }, body: 'consent=1&tz=Asia%2FJerusalem&from=https%3A%2F%2Fwww.example.com%2Fsome%2Fpath%3Fq%3D1' });
  const made = registry.get(r.headers.get('location').split('/').pop());
  const u = registry.signupOf(made);
  assert.equal(u.device, 'iPhone · Safari'); assert.deepEqual(u.country, { code: 'IL', how: 'browser language' });
  assert.equal(u.tz, 'Asia/Jerusalem'); assert.equal(u.from, 'example.com', 'the host only, never the path or query');
  assert.equal(u.visitor, rv); assert.equal(u.visits, 2); assert.ok(u.ip);
  const html = await (await fetch(`${base}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  const card = html.slice(html.indexOf(`id="a-${made.id}"`), html.indexOf('</article>', html.indexOf(`id="a-${made.id}"`)));
  assert.match(card, /Waiting to link/); assert.match(card, /removed in \d+ min/);
  assert.match(card, /Israel/); assert.match(card, /iPhone · Safari/); assert.match(card, /from example\.com/); assert.match(card, /returning browser: 1 earlier visit/);
  assert.ok(!card.includes('Minutes transcribed'), 'no empty stats for an account that never linked');
  await registry.remove(made.id);
});

test('funnel: one person per browser, crawlers and the operator left out; came → clicked → linked', async () => {
  const admin = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') };
  const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  const funnelOf = async () => { const h = await (await fetch(`${base}/admin?days=1`, { headers: admin })).text(); return [...h.matchAll(/<div class="fhead"><b>(\d+)<\/b>/g)].map((m) => Number(m[1])); };
  const before = await funnelOf();
  // A crawler and a link preview get no id and count as nobody.
  for (const bot of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'WhatsApp/2.23.20.0 A']) assert.ok(!/rv=/.test((await fetch(`${base}/`, { headers: { 'user-agent': bot } })).headers.get('set-cookie') || ''));
  // A person: lands from a referring site, the page's script reports back, visits twice, signs up twice, links once.
  const land = await fetch(`${base}/`, { headers: { 'user-agent': ua, referer: 'https://news.example.org/post/1' } });
  const rv = /rv=([0-9a-f]{20})/.exec(land.headers.get('set-cookie'))[1];
  const h = { 'user-agent': ua, cookie: `rv=${rv}`, origin: base };
  assert.equal((await fetch(`${base}/hi`, { method: 'POST', headers: h })).status, 204);
  await fetch(`${base}/`, { headers: h });
  // Two sign-ups from this browser, as /start records them (the HTTP path is covered above; its per-address limit is shared by these tests).
  const visitors = await import('../src/visitors.js');
  const signUp = () => { const x = registry.create({ signup: { visitor: rv, device: 'Android · Chrome' }, start: false }); visitors.addAccount(rv, x.id); return x; };
  const a = signUp(), b = signUp();
  let html = await (await fetch(`${base}/admin`, { headers: admin })).text();
  assert.match(html, /×2 sign-ups, same browser/, 'two waiting sign-ups from one browser are one line');
  assert.deepEqual(await funnelOf(), [before[0] + 1, before[1] + 1, before[2]], 'one person came and clicked, twice over');
  b.linkedAt = Date.now(); b.onFirstLink(b);
  assert.deepEqual(await funnelOf(), [before[0] + 1, before[1] + 1, before[2] + 1]);
  html = await (await fetch(`${base}/admin?days=1`, { headers: admin })).text();
  assert.match(html, /<span>news\.example\.org<\/span><span>1<\/span><span>1<\/span><span>1<\/span><span>100%<\/span>/);
  assert.match(html, /<span>Android<\/span>/);
  // The operator's own browser opening /admin leaves the funnel.
  await fetch(`${base}/admin`, { headers: { ...admin, cookie: `rv=${rv}` } });
  assert.deepEqual(await funnelOf(), before);
  await registry.remove(a.id); await registry.remove(b.id);
});

test('admin: wrong passwords are rate limited; healthz says only ok', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') } })).status, 401);
  assert.equal((await fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).status, 429, 'locked out even with the right password');
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
});

test('sign-up remembers whether to talk Hebrew or English', async () => {
  const start = (al) => fetch(`${base}/start`, { method: 'POST', headers: { origin: base, 'accept-language': al, 'content-type': 'application/x-www-form-urlencoded' }, body: 'consent=1', redirect: 'manual' });
  for (const [al, want] of [['he-IL,he;q=0.9,en;q=0.8', 'he'], ['fr-FR,fr;q=0.9', 'en']]) {
    const r = await start(al);
    assert.equal(r.status, 303);
    const made = registry.get(r.headers.get('location').split('/').pop());
    assert.equal(made.locale, want);
    await registry.remove(made.id);
  }
});

test('sign-up: consent required, per-IP limit, pending cap', async () => {
  const post = (body) => fetch(`${base}/start`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  assert.equal((await post('language=he')).status, 303, 'no consent → back to landing');
  assert.equal((await post('language=he')).headers.get('location'), '/');
  let r; for (let i = 0; i < 6; i++) r = await post('language=zz');
  assert.equal(r.status, 429, 'sixth attempt in an hour is refused');
});

// ---- retest findings R6, R7 ----
test('R6: the link page script runs after the DOM exists (script at the end of body, inside DOMContentLoaded)', async () => {
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie: `rl=${t.id}.${t.manageKey}` } })).text();
  const script = html.indexOf('<script'); const unlink = html.indexOf('id="unlink"'); const bodyEnd = html.indexOf('</body>');
  assert.ok(script > unlink && script < bodyEnd, 'script must come after the #unlink form');
  assert.match(html.slice(script), /DOMContentLoaded/);
  // Sanity: the script body parses (a syntax error would leave the page stuck on "Starting…").
  const src = html.slice(script).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  new Function(src); // throws on a syntax error
});

test('R7: a malformed cookie is treated as no cookie (404), never a 500', async () => {
  for (const cookie of ['rl=%', 'rl=%E0%A4%A', 'rl', '=x', `rl=${t.id}.%ZZ`]) {
    const r = await fetch(`${base}/link/${t.id}`, { headers: { cookie } });
    assert.equal(r.status, 404, `cookie ${JSON.stringify(cookie)}`);
  }
});

test('fonts are served from this origin (the CSP allows no other), and only the known files', async () => {
  const r = await fetch(`${base}/fonts/geist.woff2`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.match(r.headers.get('content-security-policy'), /font-src 'self'/);
  assert.equal((await fetch(`${base}/fonts/..%2Fweb.js`)).status, 404);
});

test('the how-it-works page is public and linked from the landing page', async () => {
  const how = await fetch(`${base}/how`);
  assert.equal(how.status, 200); assert.match(await how.text(), /How it works\./);
  assert.match(await (await fetch(`${base}/`)).text(), /href="\/how"/);
});

test('the link page has no URL to keep and no invite; leaving is pointed at WhatsApp', async () => {
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie: `rl=${t.id}.${t.manageKey}` } })).text();
  assert.ok(!html.includes(t.manageKey), 'the private key is never printed');
  assert.ok(!/Keep this page|Invite a friend/.test(html));
  assert.match(html, /write <b>leave<\/b>/);
});

test('link page: a phone defaults to a code, a desktop to the QR, and ?via= overrides', async () => {
  const cookie = `rl=${t.id}.${t.manageKey}`;
  const get = async (ua, q = '') => (await fetch(`${base}/link/${t.id}${q}`, { headers: { cookie, 'user-agent': ua } })).text();
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
  assert.match(await get(iphone), /let via='code'/); assert.match(await get(mac), /let via='qr'/);
  assert.match(await get(iphone, '?via=qr'), /let via='qr'/); assert.match(await get(mac, '?via=code'), /let via='code'/);
  assert.match(await get(mac, '?via=<script>'), /let via='qr'/, 'anything else is the default');
});

test('link with a code: the number is kept with the account; a bad one is refused; the QR can be chosen again', async () => {
  const cookie = `rl=${t.id}.${t.manageKey}`;
  const post = (path, body) => fetch(`${base}/link/${t.id}/${path}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  assert.equal((await post('code', 'phone=abc')).status, 400); assert.equal(t.pairPhone, '');
  const ok = await post('code', 'phone=%2B972%2050-123%204567');
  assert.equal(ok.status, 303); assert.equal(t.pairPhone, '972501234567');
  const api = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(api.pairByCode, true); assert.equal(api.pairingCode, null, 'no socket waiting for a scan yet: no code');
  assert.ok(!JSON.stringify(api).includes('972501234567'), 'the number itself is not echoed');
  const back = await post('qr', '');
  assert.equal(back.status, 303); assert.equal(back.headers.get('location'), `/link/${t.id}?via=qr`); assert.equal(t.pairPhone, '');
});

test('linked: one call to action into WhatsApp, the tools folded away, nothing left to do on the page', async () => {
  const cookie = `rl=${t.id}.${t.manageKey}`;
  t.ownId = '15550100000@s.whatsapp.net';
  const api = await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json();
  assert.equal(api.waMe, 'https://wa.me/15550100000');
  const html = await (await fetch(`${base}/link/${t.id}`, { headers: { cookie } })).text();
  assert.match(html, /id="fx"/); assert.match(html, /Open WhatsApp/); assert.match(html, /Record a voice note there/); assert.match(html, /const openWa="https:\/\/web\.whatsapp\.com\/"/, 'a computer opens WhatsApp Web');
  assert.ok(!/Keep this page|Then send someone|Leave it on auto|id="lang"/.test(html), 'no language selector: that is set from WhatsApp');
  t.ownId = null;
  assert.equal((await (await fetch(`${base}/api/link/${t.id}`, { headers: { cookie } })).json()).waMe, null);
});

