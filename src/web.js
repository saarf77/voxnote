/**
 * The public site: a landing page, the link page (QR), a private manage page per
 * account, and an admin health view. No page ever shows message content.
 *
 * Security posture:
 *   - every response carries a strict CSP (scripts only with a per-response
 *     nonce), no referrer off-site, nosniff, no framing; private pages are no-store
 *   - the account's private key is exchanged for an HttpOnly cookie on first
 *     visit and stripped from the URL; support can issue a fresh one (/admin/link)
 *   - every state-changing POST must come from this site (Origin / Sec-Fetch-Site)
 *   - admin uses Basic auth with a per-IP failure limit; sign-ups are limited
 *     per IP and by a global cap on accounts that have not scanned yet
 */
import express from 'express';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as registry from './registry.js';
import { LANGUAGES, PRODUCT_NAME, DAILY_MINUTES_CAP } from './tenant.js';
import { PLANS, planLabel } from './transcribe.js';
import { GLOBAL_DAILY_MINUTES, secondsToday } from './budget.js';
import * as research from './research.js';
import { dataDirIsMount } from './paths.js';
import { LOGO_SVG, LOGO_DATA_URI } from './logo.js';
import { normalizePhone, COUNTRIES, countryFromLanguage } from './pairing.js';
import { speechPerMinute } from './cost.js';
import * as visitors from './visitors.js';

const REPO_URL = process.env.REPO_URL || 'https://github.com/tomer-van-cohen/ramble';
const TAGLINE = 'Ramble, baby. Talk into WhatsApp however it comes out; every voice note shows up as clean text right under it.';
// One home: requests arriving on a retired domain are sent to the current one, path and all.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').toLowerCase();
const LEGACY_HOSTS = new Set((process.env.LEGACY_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || '';
const INVITE_CODE = process.env.INVITE_CODE || ''; // optional: closed beta behind a code
const KEY_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[a-z0-9]{1,64}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- limiters (in-memory, per process) ----------
const STARTS_PER_HOUR = Number(process.env.STARTS_PER_HOUR ?? 5);
const ADMIN_FAILS_PER_15MIN = 10;
function windowLimiter(max, windowMs) {
  const hits = new Map(); // ip -> [timestamps]
  let lastPrune = Date.now();
  const prune = () => { const now = Date.now(); for (const [ip, arr] of hits) { const keep = arr.filter((t) => now - t < windowMs); keep.length ? hits.set(ip, keep) : hits.delete(ip); } lastPrune = now; };
  return {
    blocked(ip) { const now = Date.now(); if (now - lastPrune > windowMs) prune(); return (hits.get(ip) || []).filter((t) => now - t < windowMs).length >= max; },
    hit(ip) { const now = Date.now(); const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs); arr.push(now); hits.set(ip, arr); },
  };
}
const startLimiter = windowLimiter(STARTS_PER_HOUR, 3600e3);
const adminFailLimiter = windowLimiter(ADMIN_FAILS_PER_15MIN, 15 * 60e3);

// ---------- helpers ----------
function guessLanguage(acceptLanguage = '') {
  const first = String(acceptLanguage).split(',')[0]?.trim().toLowerCase().split('-')[0] || '';
  return LANGUAGES.some(([v]) => v && v === first) ? first : '';
}
const mark = `<a class="mark" href="/">${LOGO_SVG}<span>${esc(PRODUCT_NAME)}</span></a>`;
// A voice note and its text, drawn as a chat — the product in one glance.
const WAVE_SVG = `<svg class="wave" width="130" height="22" viewBox="0 0 130 22" aria-hidden="true">${[6, 10, 16, 8, 20, 12, 7, 14, 18, 9, 5, 13, 17, 11, 6, 15, 19, 8, 12, 7, 16, 10, 5, 9, 14, 6].map((h, i) => `<rect x="${i * 5}" y="${(22 - h) / 2}" width="3" height="${h}" rx="1.5" fill="currentColor"/>`).join('')}</svg>`;
const DEMO = `<div class="chat" role="img" aria-label="A WhatsApp voice note with its text posted right under it">
<div class="b in"><span class="av">D</span><svg class="play" width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1.2v13.6L13 8z" fill="currentColor"/></svg>${WAVE_SVG}<span class="dur">1:47</span></div>
<div class="b out"><span class="quo">Voice message · 1:47</span><p>I'm stuck in traffic, I'll be there in about twenty minutes. Start without me and order me the same as last time, and if they have the lemonade get me a big one.</p><span class="t">9:41</span></div>
</div>`;
// The three typefaces are served from here: the CSP allows no third-party origin.
const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const FONT_FILES = new Set(['bricolage.woff2', 'geist.woff2', 'geist-mono.woff2']);
// The repo's star count, for the landing page: refreshed in the background at most hourly,
// and simply absent until GitHub answers (it won't while the repo is private).
const GH_REPO = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(REPO_URL)?.[1] || '';
let stars = null, starsAt = 0;
function refreshStars() {
  if (!GH_REPO || process.env.GITHUB_STARS === 'off' || Date.now() - starsAt < 3600e3) return;
  starsAt = Date.now();
  fetch(`https://api.github.com/repos/${GH_REPO}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': PRODUCT_NAME }, signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) stars = Number.isInteger(j.stargazers_count) ? j.stargazers_count : null; }).catch(() => {});
}
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
// Tolerant cookie parser: a malformed value is simply absent (never an exception).
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return ''; } };
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => { const i = p.indexOf('='); return i < 0 ? [] : [p.slice(0, i).trim(), safeDecode(p.slice(i + 1).trim())]; }).filter(([k, v]) => k && v));
const setSession = (req, res, t) => res.append('Set-Cookie', `rl=${t.id}.${t.manageKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
const clearSession = (req, res) => res.append('Set-Cookie', `rl=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);

function page(res, title, body, { poll = null, wide = false, nav = '' } = {}) {
  const nonce = res.locals.nonce;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#faf7f2"><meta name="color-scheme" content="light"><title>${esc(title)}</title>
<meta name="description" content="${esc(TAGLINE)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(TAGLINE)}"><meta property="og:type" content="website">
<link rel="icon" href="${LOGO_DATA_URI}"><link rel="apple-touch-icon" href="${LOGO_DATA_URI}">
<style nonce="${nonce}">
@font-face{font-family:"Bricolage Grotesque";font-weight:700 800;font-stretch:100%;font-display:swap;src:url(/fonts/bricolage.woff2) format("woff2")}
@font-face{font-family:Geist;font-weight:400 600;font-display:swap;src:url(/fonts/geist.woff2) format("woff2")}
@font-face{font-family:"Geist Mono";font-weight:400 500;font-display:swap;src:url(/fonts/geist-mono.woff2) format("woff2")}
:root{--bg:#faf7f2;--card:#fff;--ink:#121212;--mute:#5c5a55;--line:#e4dfd5;--green:#25d366;--chat:#efeae0;--out:#d9fdd3;--danger:#b3261e;--disp:"Bricolage Grotesque","Helvetica Neue",Helvetica,sans-serif;--mono:"Geist Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 Geist,"Helvetica Neue",Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1160px;margin:0 auto;padding-left:20px;padding-right:20px}
.narrow{max-width:500px}
.nav{display:flex;align-items:center;justify-content:space-between;height:72px}
.mark{display:inline-flex;align-items:center;gap:10px;font-family:var(--disp);font-weight:800;font-size:22px;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
.mark svg{width:30px;height:30px;display:block}
.navlink{display:inline-flex;align-items:center;height:44px;font-size:16px;font-weight:500;text-decoration:none}
h1,h2,h3{font-family:var(--disp);font-weight:800;letter-spacing:-.04em;line-height:.95;margin:0}
h1{font-size:clamp(40px,12.6vw,148px);white-space:nowrap;line-height:.92}h1 span{color:#8c877c}
h1.small{font-size:44px;white-space:normal;margin:12px 0 20px}
h2{font-size:clamp(40px,6vw,68px)}h3{font-size:22px;letter-spacing:-.03em;line-height:1}
p{margin:0}.muted{color:var(--mute);font-size:15px}.center{text-align:center}
main.narrow{padding-bottom:40px}main.narrow>p{margin:12px 0;color:var(--mute)}main.narrow b{color:var(--ink);font-weight:600}
.hero{display:flex;flex-direction:column;align-items:flex-start;gap:24px;padding-top:36px;padding-bottom:72px}
.sub{font-size:19px;line-height:1.4;color:var(--mute);max-width:560px;text-wrap:balance}
.start{display:flex;flex-direction:column;gap:14px;width:100%}
.cta{display:inline-flex;align-items:center;justify-content:center;width:100%;height:60px;padding:0 34px;border:0;border-radius:999px;background:var(--green);color:var(--ink);font:inherit;font-size:18px;font-weight:600;text-decoration:none;cursor:pointer}
.cta:active{transform:translateY(1px)}
.fine{color:var(--mute);font-size:14px}
.safe{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:15px;line-height:1.35;text-wrap:balance}.safe svg{flex:none;color:var(--mute)}
.invited{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;background:var(--ink);color:#fff;font-size:13px;font-weight:600}
label{display:block;font-size:15px;color:var(--mute);margin:0 0 8px}
select,input[type=text]{width:100%;height:52px;font:inherit;font-size:16px;padding:0 14px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--ink);appearance:none}
select{padding-right:40px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='9' viewBox='0 0 14 9'%3E%3Cpath d='M1 1l6 6 6-6' fill='none' stroke='%235c5a55' stroke-width='2'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
.chat{width:100%;max-width:520px;align-self:center;margin-top:16px;background:var(--chat);border-radius:32px;padding:16px;display:flex;flex-direction:column;gap:12px;text-align:left}
.b{color:#111b21;font-size:15px;line-height:1.45}
.b.in{align-self:flex-start;display:flex;align-items:center;gap:12px;background:#fff;border-radius:8px 20px 20px 20px;padding:12px 16px 12px 12px}
.b.out{align-self:flex-end;max-width:88%;background:var(--out);border-radius:20px 8px 20px 20px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.b .av{width:34px;height:34px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:16px;flex:none}
.b .play,.b .dur{color:var(--mute);flex:none}.b .wave{color:#8a8f8c;flex:none;max-width:40vw}
.b .dur,.b .t{font-family:var(--mono);font-size:12px}
.b .quo{border-left:3px solid #1fa855;background:rgba(0,0,0,.05);border-radius:6px;padding:6px 10px;font-size:13px;color:#2f5a43}
.b.out b{font-weight:700;line-height:1.4}.b .t{align-self:flex-end;font-size:11px;color:#54705f}
.band{border-top:1px solid var(--line);padding:64px 0}
.both{display:flex;flex-direction:column;gap:28px}
.lead{display:flex;flex-direction:column;gap:14px}.lead p{color:var(--mute);max-width:440px}
.say{background:var(--chat);border-radius:32px;padding:16px;display:flex;flex-direction:column;gap:12px}
.say span{font-family:var(--disp);font-weight:700;font-size:22px;line-height:1.1;letter-spacing:-.025em;color:#111b21;padding:16px 20px}
.say .me{align-self:flex-end;background:var(--out);border-radius:22px 8px 22px 22px}.say .them{align-self:flex-start;background:#fff;border-radius:8px 22px 22px 22px}
.facts{display:flex;flex-direction:column;gap:16px;margin-top:32px;padding-top:24px;border-top:1px solid var(--line);color:var(--mute)}.facts b{color:var(--ink);font-weight:600}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:24px;counter-reset:s}
.steps li{counter-increment:s;display:flex;align-items:center;gap:16px;font-family:var(--disp);font-weight:700;font-size:24px;line-height:1.1;letter-spacing:-.025em}
.steps li::before{content:counter(s);width:44px;height:44px;border-radius:50%;background:var(--green);display:grid;place-items:center;font-weight:800;font-size:20px;flex:none}
.steps.long li{align-items:flex-start}.steps li div{display:flex;flex-direction:column;gap:8px}.steps li span{font:400 17px/1.5 Geist,"Helvetica Neue",Helvetica,sans-serif;letter-spacing:0;color:var(--mute)}
.howhero{display:flex;flex-direction:column;gap:16px;padding-top:56px;padding-bottom:72px}.howhero h1{font-size:clamp(40px,11vw,124px)}
.facts.plain{margin-top:28px;padding-top:0;border:0}.facts.plain:first-child{margin-top:0}
.asks{display:flex;flex-direction:column;gap:48px;margin-top:48px}.ask{display:flex;flex-direction:column;gap:20px}
.ask h3{font-size:28px;font-weight:700}.ask p{color:var(--mute);max-width:460px;margin-top:10px}.intro{color:var(--mute);margin-top:14px}
.mini{background:var(--chat);border-radius:28px;padding:16px;display:flex;flex-direction:column;gap:10px}
.mini small{font-family:var(--mono);font-size:12px;letter-spacing:.04em;color:var(--mute);padding:0 4px 4px}
.mini div{max-width:86%;padding:10px 14px;font-size:15px;line-height:1.45;color:#111b21}.mini b{font-weight:600}
.mini .me{align-self:flex-end;background:var(--out);border-radius:18px 6px 18px 18px}.mini .bot{align-self:flex-start;background:#fff;border-radius:6px 18px 18px 18px}
.mini .q{display:block;border-left:4px solid #0a7a43;background:rgba(0,0,0,.06);border-radius:8px;padding:6px 10px;margin:-2px -4px 6px;font-size:13px;line-height:1.35;color:#4f5f56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}.mini .q b{display:block;color:#0a7a43}
.mini .vn{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--mute);font-family:var(--mono);font-size:12px}.mini .vn em{flex-basis:100%;font:italic 12px Geist,sans-serif}.mini .vn .wave{color:#6f8f7a;width:90px}
.oss{display:flex;flex-direction:column;align-items:flex-start;gap:28px}.oss h2{font-size:clamp(36px,4vw,44px)}.oss p{color:var(--mute);margin-top:10px}
.gh{display:inline-flex;align-items:stretch;height:56px;border-radius:999px;overflow:hidden;border:1.5px solid var(--ink);text-decoration:none;font-size:16px;font-weight:600;flex:none}
.gh span{display:flex;align-items:center;gap:10px;padding:0 22px;background:var(--ink);color:#fff}.gh span+span{gap:8px;padding:0 20px 0 16px;background:var(--card);color:var(--ink);font-family:var(--mono);font-size:15px;font-weight:400}
.close{background:var(--ink);padding:96px 0}.close .wrap{display:flex;flex-direction:column;align-items:center;gap:28px;text-align:center}
.close h2{color:#fff;font-size:clamp(56px,8vw,112px)}
.foot{display:flex;flex-direction:column;gap:14px;padding-top:36px;padding-bottom:44px;color:var(--mute);font-size:14px}.foot nav{display:flex;gap:22px}
.pill{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;border:1px solid var(--line);font-size:13px;font-weight:600;color:var(--mute)}
.pill.ok{background:var(--ink);border-color:var(--ink);color:#fff}
.pill i{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}.pill.ok i{background:var(--green)}
#box{display:flex;flex-direction:column;gap:14px;padding:12px 0 28px}#box .pill{align-self:flex-start}
#box h1{font-size:56px;white-space:normal}#box p{color:var(--mute)}#box p.go{color:var(--ink);font-size:19px}#box .cta{margin:6px 0 4px}
#fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9}
.tools{display:none;flex-direction:column;gap:18px;border-top:1px solid var(--line);padding:22px 0 8px}.on .tools{display:flex}
.tools form{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tools label{margin:0;flex:none}.tools select{flex:1;min-width:160px;height:44px}
.quiet{background:none;border:0;padding:0;color:var(--danger);font:inherit;font-size:15px;font-weight:600;text-decoration:underline;cursor:pointer}
.qr{display:block;width:100%;max-width:302px;margin:8px auto;border-radius:24px;background:#fff;padding:16px;border:1px solid var(--line)}
.code{font-family:var(--mono);font-size:44px;font-weight:500;letter-spacing:.12em;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px 12px;margin:8px 0}.code i{font-style:normal;color:var(--mute);margin:0 4px}
a.swap{display:inline-block;margin-top:8px;color:var(--mute);font-size:15px}
button.code{display:block;width:100%;color:var(--ink);cursor:pointer;margin:4px 0 0}
.phone{display:flex;flex-direction:column;gap:12px;width:100%}.phone label{margin:0;color:var(--ink);font-weight:600;font-size:16px}
.tel{display:flex;align-items:stretch;height:66px;border:1.5px solid var(--line);border-radius:18px;background:var(--card);overflow:hidden}.tel:focus-within{border-color:var(--ink)}
.cc{position:relative;display:flex;align-items:center;gap:6px;padding:0 12px 0 16px;border-right:1px solid var(--line);flex:none;font-size:19px;font-weight:600}
.cc em{font-style:normal;font-size:24px;line-height:1}.cc svg{color:var(--mute)}
.cc select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:16px}
.tel input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--ink);font:500 22px/1 var(--mono);letter-spacing:.02em;padding:0 16px}
.tel input::placeholder{color:#b8b3a8}
.hint{font-size:15px;color:var(--mute);min-height:22px}.hint b{color:var(--ink);font-family:var(--mono);font-weight:500}
.howto{list-style:none;counter-reset:h;margin:6px 0 2px;padding:0;display:flex;flex-direction:column;gap:12px;width:100%}
.howto li{counter-increment:h;position:relative;min-height:30px;padding:4px 0 0 44px;font-size:17px;line-height:1.35;color:var(--ink)}
.howto li::before{content:counter(h);position:absolute;left:0;top:0;width:30px;height:30px;border-radius:50%;background:var(--chat);display:grid;place-items:center;font-weight:700;font-size:15px}
.row{border-top:1px solid var(--line);padding:22px 0;display:flex;flex-direction:column;align-items:flex-start;gap:12px}.row form{width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:12px}
.after{display:none}.on .after{display:flex}
code{font-family:var(--mono);font-size:13px;word-break:break-all}.row>code{display:block;width:100%;background:var(--chat);border-radius:12px;padding:12px 14px}
.btn{display:inline-flex;align-items:center;height:44px;padding:0 18px;border-radius:999px;border:1.5px solid var(--ink);background:transparent;color:var(--ink);font:inherit;font-size:15px;font-weight:600;cursor:pointer}
button.danger{width:100%;height:52px;border-radius:999px;border:1.5px solid var(--danger);background:transparent;color:var(--danger);font:inherit;font-size:16px;font-weight:600;cursor:pointer}
b.danger{color:var(--danger)}.ok{color:#0a6b3c}
.legal section{border-top:1px solid var(--line);padding:24px 0;display:flex;flex-direction:column;gap:10px}.legal p{color:var(--mute);font-size:16px}
.back{display:block;text-align:center;padding:12px 0 8px;color:var(--mute);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px;overflow-x:auto}
table{border-collapse:collapse;font-size:14px;white-space:nowrap}th,td{padding:4px 8px;text-align:left}
@media(min-width:860px){
.wrap{padding-left:40px;padding-right:40px}.narrow{padding-left:20px;padding-right:20px}.nav{height:88px}
.hero{align-items:center;text-align:center;gap:32px;padding-top:72px;padding-bottom:96px}.sub{font-size:24px}
.start{align-items:center;width:auto}.cta{width:auto}.start input{width:320px}
.chat{margin-top:24px;padding:24px}.b{font-size:16px}
.band{padding:96px 0}.both{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}.lead h2{font-size:clamp(40px,4.4vw,64px);white-space:nowrap}.lead p{font-size:20px}
.say{padding:28px;gap:16px}.say span{font-size:30px;padding:20px 28px}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:56px;padding-top:32px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:48px}.steps li{flex-direction:column;align-items:flex-start;gap:20px;font-size:32px}
.oss{flex-direction:row;align-items:center;justify-content:space-between}.oss p{font-size:19px}
.howhero{gap:24px;padding-top:96px;padding-bottom:110px}
.asks{gap:72px;margin-top:72px}.ask{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}.ask h3{font-size:40px}.ask p{font-size:19px;margin-top:14px}.intro{font-size:20px}
.mini{padding:24px}.mini div{font-size:16px}
.close{padding:140px 0}.close .wrap{gap:40px}
.foot{flex-direction:row;align-items:center;justify-content:space-between}
}
</style></head><body><header class="nav wrap${wide ? '' : ' narrow'}">${mark}${nav}</header><main${wide ? '' : ' class="wrap narrow"'}>${body}</main>${poll ? `<script nonce="${nonce}">document.addEventListener('DOMContentLoaded',()=>{${poll}\n});</script>` : ''}</body></html>`;
}

// ---------- who signed up (coarse, for the admin page) ----------
// Device and browser from the agent string: a label, never the string itself.
function deviceOf(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  const app = /FBAN|FBAV/.test(ua) ? 'Facebook app' : /Instagram/.test(ua) ? 'Instagram app' : /LinkedInApp/.test(ua) ? 'LinkedIn app' : /WhatsApp/.test(ua) ? 'WhatsApp' : /Telegram/.test(ua) ? 'Telegram'
    : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, app].filter(Boolean).join(' · ') || (ua ? 'Other' : 'Unknown');
}
// A country: from the edge's geo header when a proxy in front sends one, else the region in the browser's language.
function countryOf(req) {
  const edge = String(req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country-code') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(edge) && edge !== 'XX') return { code: edge, how: 'network' };
  const region = /^[a-z]{2,3}-([a-z]{2})\b/i.exec(String(req.get('accept-language') || '').split(',')[0].trim())?.[1];
  return region ? { code: region.toUpperCase(), how: 'browser language' } : null;
}
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => { try { return regionNames.of(code) || code; } catch { return code; } };
const flag = (code) => (/^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
// Where they came from: the referring site's host (the landing page reports it), or an invite.
const sourceHost = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').slice(0, 80) : ''; } catch { return ''; } };
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|preview|externalhit|^WhatsApp\/|^curl|^wget|python|go-http|node-fetch|axios|undici|headless|lighthouse|uptime|monitor|scanner/i;
const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// ---------- admin page ----------
// One card per account, newest activity first: who it is (WhatsApp name and number),
// whether it works, what it used, and the support tools folded underneath. Never content.
const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const when = (ms) => (ms ? `<time title="${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC">${ago(ms)}</time>` : '—');
const phoneText = (d) => (d ? `+${d}` : '');
// The last 7 UTC days before today and today itself, as small bars.
function usageBars(history = [], today = 0) {
  const byDay = new Map(history.map((h) => [h.day, h.minutes]));
  const days = Array.from({ length: 8 }, (_, i) => { const d = new Date(Date.now() - (7 - i) * 864e5).toISOString().slice(0, 10); return [d, i === 7 ? today : byDay.get(d) || 0]; });
  const max = Math.max(1, ...days.map(([, m]) => m));
  const total = days.reduce((a, [, m]) => a + m, 0);
  return `<svg class="bars" viewBox="0 0 80 34" preserveAspectRatio="none" role="img" aria-label="Minutes of audio per day, last 8 days">${days.map(([d, m], i) => { const h = Math.max(1.5, (m / max) * 34); return `<rect x="${i * 10 + 1}" y="${(34 - h).toFixed(1)}" width="8" height="${h.toFixed(1)}" rx="1.5"${i === 7 ? ' class="now"' : ''}><title>${i === 7 ? 'today' : d}: ${m} min</title></rect>`; }).join('')}</svg><span class="muted">${total} min in 8 days</span>`;
}
function stateOf(t) {
  if (t.ready && t.lastError && Date.now() - t.lastError.at < 864e5) return ['warn', 'Connected, recent error'];
  if (t.ready) return ['ok', 'Connected'];
  if (!t.linkedAt) return ['wait', 'Waiting to link'];
  return ['bad', { logged_out: 'Logged out of WhatsApp', qr: 'Needs a new scan', reconnecting: 'Reconnecting', starting: 'Starting' }[t.mode] || `Offline (${t.mode})`];
}
const nonceStyle = (nonce, css) => `<style nonce="${nonce}">${css}</style>`;
const ADMIN_CSS = `
.adm{padding-bottom:64px}.adm h1.small{margin:4px 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:14px 16px}
.tile small{display:block;color:var(--mute);font-size:13px}.tile b{font-family:var(--disp);font-size:30px;letter-spacing:-.03em;line-height:1.1}.tile span{color:var(--mute);font-size:14px}.tile b .danger{color:var(--danger);font-size:22px}
.adbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.adbar input{flex:1 1 240px;height:44px;border-radius:999px;padding:0 18px}
.chip{height:36px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);font:inherit;font-size:14px;cursor:pointer;color:var(--ink)}
.chip[aria-pressed=true]{background:var(--ink);color:#fff;border-color:var(--ink)}
.acct{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:12px}
.acct[hidden]{display:none}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px}
.who h3{font-size:22px}.who a{font-family:var(--mono);font-size:15px}.who code{color:var(--mute);font-size:12px}
.dot{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;padding:3px 10px;border-radius:999px;margin-left:auto}
.dot::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.dot.ok{color:#0a6b3c;background:#e3f6ea}.dot.warn{color:#8a5a00;background:#fff3d6}.dot.bad{color:var(--danger);background:#fbe7e5}.dot.wait{color:var(--mute);background:var(--chat)}
.when{color:var(--mute);font-size:14px;margin:4px 0 14px}
.facts2{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px 20px}
.facts2 div{min-width:0}.facts2 small{display:block;color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.facts2 p{font-size:15px;overflow-wrap:anywhere}.facts2 .muted{font-size:13px}
.bars{display:block;width:100%;max-width:200px;height:34px;margin:4px 0 2px}
.bars rect{fill:var(--green)}.bars rect.now{fill:var(--ink)}
.err{margin-top:14px;padding:10px 14px;border-radius:12px;background:#fbe7e5;color:var(--danger);font-size:14px;overflow-wrap:anywhere}
.acct details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.acct summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--mute)}
.ops{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px}
.ops form{display:flex;gap:8px;align-items:flex-end}.ops label{margin:0 0 4px;font-size:13px}.ops .f{flex:1;min-width:0}
.ops select,.ops input[type=text]{height:40px;border-radius:10px;font-size:14px}
.ops .btn{height:40px;padding:0 14px;font-size:14px;white-space:nowrap}
.adout{margin-top:10px;font-size:13px;font-family:var(--mono);overflow-wrap:anywhere;color:var(--mute)}
.empty{color:var(--mute);padding:24px 0}
.funnel{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:28px}
.fttl{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:6px}.fttl h2,.sect{font-size:28px}.fttl nav{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;text-decoration:none}
.sect{margin:0 0 14px}
.fsteps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:16px 0}
.fhead{display:flex;align-items:baseline;gap:8px}.fhead b{font-family:var(--disp);font-size:40px;letter-spacing:-.03em;line-height:1}.fhead span{font-size:15px}
.fbar{display:block;width:100%;height:10px;margin:8px 0 6px}.fbar rect{fill:var(--green)}.fbar rect.bg{fill:var(--chat)}
.fstep small{color:var(--mute);font-size:13px}
.fbreaks{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;border-top:1px solid var(--line);padding-top:14px}
.fbreak h4{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
.frow{display:grid;grid-template-columns:minmax(0,2fr) repeat(4,minmax(0,1fr));gap:6px;font-size:14px;padding:4px 0;border-bottom:1px solid var(--line)}
.frow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.frow span:not(:first-child){text-align:right}.frow.fh{color:var(--mute);font-size:12px}
.bits{margin-top:14px;font-size:14px;overflow-wrap:anywhere}.bits code{font-size:13px}.slim{padding:14px 18px}.slim h3{font-size:18px}.slim .who>.muted{font-size:14px}.slim .bits{margin-top:6px}
`;
// Buttons post with fetch (the browser re-sends the Basic credentials) and show the answer inline.
const ADMIN_JS = `
const q=document.getElementById('q'),cards=[...document.querySelectorAll('.acct')],none=document.getElementById('none');let f='all';
const apply=()=>{const s=q.value.trim().toLowerCase().replace(/[\\s+()-]/g,'');let n=0;for(const c of cards){const on=(f==='all'||c.dataset.state===f||(f==='bad'&&c.dataset.state==='warn'))&&(!s||c.dataset.find.includes(s));c.hidden=!on;n+=on;}none.hidden=n>0;};
q.addEventListener('input',apply);apply();
for(const b of document.querySelectorAll('.adbar .chip'))b.addEventListener('click',()=>{f=b.dataset.f;for(const x of document.querySelectorAll('.adbar .chip'))x.setAttribute('aria-pressed',x===b);apply();});
for(const form of document.querySelectorAll('form[data-op]'))form.addEventListener('submit',async(e)=>{e.preventDefault();
  if(form.dataset.confirm&&!confirm(form.dataset.confirm))return;
  const out=form.closest('.acct').querySelector('.adout'),u=new URL(form.getAttribute('action'),location.origin);for(const [k,v] of new FormData(form))u.searchParams.set(k,v);
  out.textContent='…';try{const r=await fetch(u,{method:'POST'});const j=await r.json().catch(()=>({}));out.textContent=(r.ok?'✓ ':'✗ ')+JSON.stringify(j);if(r.ok&&form.dataset.reload)setTimeout(()=>location.reload(),900);}catch(err){out.textContent='✗ '+err.message;}});
`;
// Minutes and dollars per account. Metered exactly since `totals.since`; before that only the
// daily minutes exist, priced at the server's measured rate (or the speech price alone).
const usd = (v) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
function spend(t, rate) {
  const tot = t.totals || {};
  const ownMin = (tot.ownSeconds || 0) / 60, othersMin = (tot.othersSeconds || 0) / 60;
  const sinceDay = tot.since ? new Date(tot.since).toISOString().slice(0, 10) : '9999';
  const earlierMin = (t.usageHistory || []).filter((h) => h.day < sinceDay).reduce((a, h) => a + h.minutes, 0);
  const earlierUsd = earlierMin * (rate || speechPerMinute(t.model));
  return { ownMin, othersMin, meteredMin: ownMin + othersMin, usd: tot.usd || 0, unpriced: !!tot.unpriced, earlierMin, earlierUsd };
}
// Where a sign-up came from, as short pieces: country, device, address, source, and whether the browser was here before.
function signupBits(t, byId) {
  const u = t.signup; if (!u) return [];
  const c = u.country;
  const other = u.hadAccount && u.hadAccount !== t.id ? byId.get(u.hadAccount) : null;
  return [
    c ? `${flag(c.code)} ${esc(countryName(c.code))}${c.how === 'network' ? '' : ' <span class="muted">(browser language)</span>'}` : '',
    u.tz ? `<span class="muted">${esc(u.tz.replace(/_/g, ' '))}</span>` : '',
    esc(u.device || ''),
    u.ip ? `<code>${esc(u.ip)}</code>` : '',
    u.from ? `from ${esc(u.from)}` : u.invited ? 'from an invite' : 'direct',
    u.visitor ? (u.visits > 1 ? `returning browser: ${u.visits - 1} earlier visit${u.visits === 2 ? '' : 's'}, first ${ago(u.firstSeen)}` : 'first visit') : 'no visitor cookie',
    u.earlierAccounts ? `<span class="danger">${u.earlierAccounts} earlier sign-up${u.earlierAccounts === 1 ? '' : 's'} from this browser</span>` : '',
    other ? `browser already had <a href="#a-${esc(other.id)}">${esc(other.waName || other.id.slice(0, 8))}</a>` : u.hadAccount && u.hadAccount !== t.id ? 'browser already had an account' : '',
  ].filter(Boolean);
}
// An account that never linked: one line, and when it will be removed.
function pendingCard(t, byId, more = []) {
  const left = Math.max(0, Math.round((t.expiresAt - Date.now()) / 60e3));
  const find = [t.id, t.signup?.ip, t.signup?.device, t.signup?.from, t.signup?.country && countryName(t.signup.country.code)].filter(Boolean).join(' ').toLowerCase().replace(/[\s+()-]/g, '');
  return `<article class="acct slim" data-state="wait" data-find="${esc(find)}" id="a-${esc(t.id)}">
<div class="who"><h3>Waiting to link${more.length ? ` <span class="muted">×${more.length + 1} sign-ups, same browser</span>` : ''}</h3><code>${esc([t, ...more].map((x) => x.id.slice(0, 8)).join(', '))}</code><span class="muted">signed up ${when(t.createdAt)} · ${t.mode === 'qr' ? 'code or QR on screen' : esc(t.mode)} · removed in ${left} min unless they link</span><span class="dot wait">Waiting</span></div>
${t.signup ? `<p class="bits">${signupBits(t, byId).join(' · ')}</p>` : ''}
</article>`;
}
// Sign-ups still waiting that came from the same browser are one person: one line for all of them.
function cards(ts, byCode, rate, byId) {
  const groups = new Map();
  for (const t of ts) if (!t.linkedAt && t.signup?.visitor) groups.set(t.signup.visitor, [...(groups.get(t.signup.visitor) || []), t]);
  return ts.map((t) => {
    if (t.linkedAt || !t.signup?.visitor) return adminCard(t, byCode, rate, byId);
    const g = groups.get(t.signup.visitor);
    return g[0] === t ? pendingCard(t, byId, g.slice(1)) : '';
  }).join('');
}
function adminCard(t, byCode, rate, byId) {
  if (!t.linkedAt) return pendingCard(t, byId);
  const [state, stateLabel] = stateOf(t);
  const $ = spend(t, rate);
  const name = t.waName || t.label || (t.linkedAt ? 'No name' : 'Not linked yet');
  const inviter = t.referredBy ? byCode.get(t.referredBy) : null;
  const find = [t.waName, t.label, t.phone, t.id, t.controlGroup].filter(Boolean).join(' ').toLowerCase().replace(/[\s+()-]/g, '');
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const langNow = t.language === 'auto' ? '' : t.language;
  return `<article class="acct" data-state="${state}" data-find="${esc(find)}" id="a-${esc(t.id)}">
<div class="who"><h3>${esc(name)}</h3>${t.phone ? `<a href="https://wa.me/${esc(t.phone)}" rel="noopener" target="_blank">${esc(phoneText(t.phone))}</a>` : ''}<code>${esc(t.id.slice(0, 8))}</code><span class="dot ${state}">${esc(stateLabel)}</span></div>
<p class="when">Signed up ${when(t.createdAt)} · linked ${when(t.linkedAt)} · last voice note ${when(t.lastMessageAt)}</p>
<div class="facts2">
<div><small>Audio today</small><p><b>${t.minutesToday}</b>${t.dailyMinutes ? ` / ${t.dailyMinutes}` : ''} min${t.bonusMinutes ? ` <span class="muted">(+${t.bonusMinutes} bonus)</span>` : ''}</p></div>
<div><small>Transcribed</small><p><b>${(t.totals?.own || 0) + (t.totals?.others || 0)}</b> recordings<br><span class="muted">${t.totals?.own || 0} theirs · ${t.totals?.others || 0} from others${t.totals?.since ? ` · since ${new Date(t.totals.since).toISOString().slice(0, 10)}` : ''}</span></p></div>
<div><small>Minutes transcribed</small><p><b>${Math.round($.meteredMin + $.earlierMin)}</b> min<br><span class="muted">${Math.round($.ownMin)} theirs · ${Math.round($.othersMin)} from others${$.earlierMin ? ` · ${$.earlierMin} before counting` : ''}</span></p></div>
<div><small>Cost</small><p><b>${usd($.usd + $.earlierUsd)}</b>${$.earlierUsd || $.unpriced ? ' <span class="muted">(estimate)</span>' : ''}<br><span class="muted">${$.meteredMin >= 1 ? `${usd($.usd / $.meteredMin)}/min` : ''}${$.earlierUsd ? `${$.meteredMin >= 1 ? ' · ' : ''}~${usd($.earlierUsd)} before counting` : ''}</span></p></div>
<div><small>Usage</small>${usageBars(t.usageHistory, t.minutesToday)}</div>
<div><small>Since restart</small><p>${t.stats.transcribed} done · ${t.stats.dropped} skipped · <span${t.stats.failed ? ' class="danger"' : ''}>${t.stats.failed} failed</span></p></div>
<div><small>Chats</small><p>${t.enabledGroups} groups on · ${t.mutedChats} chats off</p></div>
<div><small>Plan · language</small><p>${esc(t.plan)} · ${esc(t.model)}<br><span class="muted">${esc(t.language)}${t.abModel ? ` · A/B ${esc(t.abModel)}` : ''}${t.keepAudio ? ' · 🎧 keeping audio' : ''}</span></p></div>
<div><small>Control group</small><p>${t.controlGroup ? esc(t.controlGroup) : `<span class="danger">none</span>`}${t.needsManualGroup ? ' <span class="muted">(needs manual)</span>' : ''}</p></div>
<div><small>Invites</small><p>${t.invited} friend${t.invited === 1 ? '' : 's'} joined${inviter ? `<br><span class="muted">invited by <a href="#a-${esc(inviter.id)}">${esc(inviter.waName || inviter.label || inviter.id.slice(0, 8))}</a></span>` : ''}</p></div>
</div>
${t.signup ? `<p class="bits"><b>Signed up from</b> ${signupBits(t, byId).join(' · ')}</p>` : ''}
${t.lastError ? `<div class="err"><b>Last error</b> ${when(t.lastError.at)}: ${esc(t.lastError.message)}</div>` : ''}
<details><summary>Support tools</summary><div class="ops">
<form data-op action="/admin/plan/${esc(t.id)}" data-reload="1"><div class="f"><label>Plan</label><select name="plan">${PLANS.map((p) => opt(p, `${p} · ${planLabel(p)}`, t.plan)).join('')}</select></div><button class="btn">Set</button></form>
<form data-op action="/admin/language/${esc(t.id)}" data-reload="1"><div class="f"><label>Language</label><select name="code">${LANGUAGES.map(([v, , en]) => opt(v, en, langNow)).join('')}</select></div><button class="btn">Set</button></form>
<form data-op action="/admin/ab/${esc(t.id)}" data-reload="1"><div class="f"><label>A/B models (comma-separated, empty = off)</label><input type="text" name="model" value="${esc(t.abModel || '')}"></div><button class="btn">Set</button></form>
<form data-op action="/admin/keep-audio/${esc(t.id)}" data-reload="1"><input type="hidden" name="on" value="${t.keepAudio ? '0' : '1'}"><div class="f"><label>Keep recordings for research</label><p class="muted">${t.keepAudio ? 'On' : 'Off'}</p></div><button class="btn">${t.keepAudio ? 'Turn off' : 'Turn on'}</button></form>
<form data-op action="/admin/link/${esc(t.id)}" data-confirm="Issue a new private link? The old one stops working."><div class="f"><label>Private link</label><p class="muted">Owner lost it?</p></div><button class="btn">New link</button></form>
<form data-op action="/admin/control-group/${esc(t.id)}" data-confirm="Create a new control group in this account's WhatsApp?" data-reload="1"><input type="hidden" name="force" value="1"><div class="f"><label>Control group</label><p class="muted">Deleted by the owner?</p></div><button class="btn">Recreate</button></form>
</div><p class="adout"></p></details>
</article>`;
}
// The funnel: people (one per browser) who first came in the period, how many clicked
// "Link my WhatsApp", and how many finished linking. Crawlers, link previews and the
// operator's own browser are left out; see visitors.js.
const FUNNEL_PERIODS = [[1, 'Last 24h'], [7, '7 days'], [30, '30 days'], [0, 'All time']];
const deviceKind = (d = '') => { const os = d.split(' · ')[0]; return ['iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux', 'ChromeOS'].includes(os) ? os : 'Other'; };
function funnel(days, tenants) {
  const start = days ? Date.now() - days * 864e5 : 0;
  const linkedIds = new Set(tenants.filter((t) => t.linkedAt).map((t) => t.id));
  const people = visitors.list().map(([, v]) => v).filter((v) => !v.staff && (v.human || v.accounts.length));
  const since = people.filter((v) => v.human).reduce((m, v) => Math.min(m, v.first), Infinity);
  const steps = (vs) => {
    const clicked = vs.filter((v) => v.accounts.length);
    return { came: vs.length, clicked: clicked.length, linked: clicked.filter((v) => v.linkedAt || v.accounts.some((a) => linkedIds.has(a))).length };
  };
  const cohort = people.filter((v) => v.first >= start);
  const by = (key) => [...cohort.reduce((m, v) => m.set(key(v), [...(m.get(key(v)) || []), v]), new Map())].map(([k, vs]) => [k, steps(vs)]).sort((a, b) => b[1].came - a[1].came);
  return { ...steps(cohort), since: Number.isFinite(since) ? since : null, bySource: by((v) => v.from || 'direct'), byDevice: by((v) => deviceKind(v.device)) };
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const bar = (n, max) => `<svg class="fbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="10" rx="2" class="bg"/><rect width="${max ? Math.max(n ? 1 : 0, (n / max) * 100).toFixed(1) : 0}" height="10" rx="2"/></svg>`;
function funnelPanel(f, days) {
  const step = (label, n, note) => `<div class="fstep"><div class="fhead"><b>${n}</b><span>${label}</span></div>${bar(n, f.came)}<small>${note}</small></div>`;
  const rows = (title, list) => list.length ? `<div class="fbreak"><h4>${title}</h4><div class="frow fh"><span></span><span>came</span><span>clicked</span><span>linked</span><span>overall</span></div>${list.map(([k, x]) => `<div class="frow"><span>${esc(k)}</span><span>${x.came}</span><span>${x.clicked}</span><span>${x.linked}</span><span>${pct(x.linked, x.came)}</span></div>`).join('')}</div>` : '';
  return `<section class="funnel"><div class="fttl"><h2>Funnel</h2><nav>${FUNNEL_PERIODS.map(([d, l]) => `<a class="chip" aria-pressed="${d === days}" href="/admin?days=${d}">${l}</a>`).join('')}</nav></div>
<p class="muted">People who first came ${days ? `in the ${days === 1 ? 'last 24 hours' : `last ${days} days`}` : 'ever'}, one per browser. Crawlers, link previews and your own browser are left out.${f.since ? ` Counting since ${new Date(f.since).toISOString().slice(0, 10)}.` : ' Counting starts with the next visit.'}</p>
<div class="fsteps">
${step('came to the site', f.came, 'one per browser')}
${step('clicked “Link my WhatsApp”', f.clicked, `${pct(f.clicked, f.came)} of those who came · ${f.came - f.clicked} left without clicking`)}
${step('linked WhatsApp', f.linked, `${pct(f.linked, f.clicked)} of those who clicked · ${f.clicked - f.linked} stopped at the QR / code`)}
</div>
<div class="fbreaks">${rows('By source', f.bySource)}${rows('By device', f.byDevice)}</div>
</section>`;
}
function adminPage(o, nonce, days = 30) {
  const byCode = new Map(o.tenants.map((t) => [t.inviteCode, t]));
  const byId = new Map(o.tenants.map((t) => [t.id, t]));
  const rank = (t) => (t.ready ? 0 : t.linkedAt ? 1 : 2);
  const ts = [...o.tenants].sort((a, b) => rank(a) - rank(b) || (b.lastMessageAt || b.linkedAt || b.createdAt) - (a.lastMessageAt || a.linkedAt || a.createdAt));
  const errors = ts.filter((t) => stateOf(t)[0] === 'warn' || stateOf(t)[0] === 'bad').length;
  // The server's measured dollars per minute, once there is enough to measure; it prices the minutes from before the meter.
  const measured = ts.reduce((a, t) => [a[0] + (t.totals?.usd || 0), a[1] + ((t.totals?.ownSeconds || 0) + (t.totals?.othersSeconds || 0)) / 60], [0, 0]);
  const rate = measured[1] >= 5 ? measured[0] / measured[1] : 0;
  const all = ts.map((t) => spend(t, rate));
  const allMin = all.reduce((a, x) => a + x.meteredMin + x.earlierMin, 0), allUsd = all.reduce((a, x) => a + x.usd + x.earlierUsd, 0);
  const tile = (label, big, small = '') => `<div class="tile"><small>${label}</small><b>${big}</b> <span>${small}</span></div>`;
  return `${nonceStyle(nonce, ADMIN_CSS)}<div class="wrap adm"><h1 class="small">Admin</h1>
<div class="tiles">
${tile('Connected', o.connected, `of ${o.accounts} · cap ${o.max}`)}
${tile('Transcribed', ts.reduce((n, t) => n + (t.totals?.own || 0) + (t.totals?.others || 0), 0), 'recordings, all accounts')}
${tile('Minutes', Math.round(allMin), 'transcribed, all accounts')}
${tile('Cost', usd(allUsd), rate ? `${usd(rate)}/min measured` : 'estimate')}
${tile('Waiting to link', o.pending)}
${tile('Need attention', errors)}
${tile('Audio today', o.budget.serverMinutesToday, `${o.budget.serverDailyMinutes ? `/ ${o.budget.serverDailyMinutes} ` : ''}min${o.budget.perAccountDailyMinutes ? ` · ${o.budget.perAccountDailyMinutes}/account` : ''}`)}
${tile('Storage', o.dataMounted === false ? '<span class="danger">NOT MOUNTED</span>' : 'OK', 'data volume')}
</div>
${funnelPanel(funnel(days, o.tenants), days)}
<h2 class="sect">Accounts</h2>
<div class="adbar"><input type="text" id="q" placeholder="Search name, number, id, group" autocomplete="off">
<button class="chip" data-f="all" aria-pressed="true">All</button><button class="chip" data-f="ok" aria-pressed="false">Connected</button><button class="chip" data-f="bad" aria-pressed="false">Need attention</button><button class="chip" data-f="wait" aria-pressed="false">Waiting</button></div>
${cards(ts, byCode, rate, byId)}
<p class="empty" id="none"${ts.length ? ' hidden' : ''}>${ts.length ? 'No account matches.' : 'No accounts yet.'}</p>
</div>`;
}

export function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  // Which proxy hops to trust for the client IP. Railway/most PaaS: 1 hop. Direct exposure: 0.
  const tp = process.env.TRUST_PROXY ?? '1';
  app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  // A retired domain forwards to the current one (health checks excepted, so the old name can still be probed).
  app.use((req, res, next) => {
    if (!CANONICAL_HOST || req.path === '/healthz' || !LEGACY_HOSTS.has(String(req.hostname || '').toLowerCase())) return next();
    // A form posted from a page still open (or cached) on the old domain cannot be forwarded as a
    // POST: the browser would re-send it cross-site and the check below would refuse it. It lands
    // on the new home page instead, one click from where it was.
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.redirect(303, `https://${CANONICAL_HOST}/`);
    res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  });
  // Security headers on every response; private pages are never cached.
  app.use((req, res, next) => {
    res.locals.nonce = randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${res.locals.nonce}'; style-src 'nonce-${res.locals.nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      // same-origin, not no-referrer: nothing leaves the site either way, but under no-referrer a
      // browser sends our own forms with "Origin: null", which the cross-site check cannot tell from an attack.
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (/^\/(link|api|admin|unlink)/.test(req.path)) res.set('Cache-Control', 'no-store');
    next();
  });
  // Cross-site POSTs are refused: a browser always sends Origin (or Sec-Fetch-Site) on them.
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin'), site = req.get('sec-fetch-site');
    // "Origin: null" is what a browser sends when it withholds the origin (a page still cached with
    // the old no-referrer policy, a privacy mode): then Sec-Fetch-Site, which a page cannot forge, decides.
    if (origin && origin !== 'null') {
      let ok = false;
      try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
      if (!ok) return res.status(403).type('text').send('Cross-site request refused');
    } else if (origin === 'null' ? site !== 'same-origin' : site === 'cross-site') return res.status(403).type('text').send('Cross-site request refused');
    next();
  });

  app.get('/fonts/:file', (req, res) => {
    if (!FONT_FILES.has(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/woff2').sendFile(join(FONT_DIR, req.params.file));
  });

  // ---------- returning browsers ----------
  // Public pages give a browser an anonymous id (a random cookie) and count its visits; see visitors.js.
  // Crawlers and link previews get none: they are not people, and would each look like a new one.
  const track = (req, res) => {
    const ua = String(req.get('user-agent') || '');
    if (!ua || BOT_RE.test(ua)) return;
    let id = cookies(req).rv;
    if (!visitors.VISITOR_RE.test(id || '')) { id = visitors.newVisitorId(); res.append('Set-Cookie', `rv=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`); }
    let from = sourceHost(req.get('referer'));
    if (from === String(req.hostname || '').replace(/^www\./, '')) from = '';
    visitors.visit(id, { device: deviceOf(ua), from: from || (req.path.startsWith('/i/') ? 'invite' : '') });
  };
  // The landing page's script reports back: a browser that runs scripts is a person, not a crawler.
  app.post('/hi', (req, res) => { const id = cookies(req).rv; if (visitors.VISITOR_RE.test(id || '')) visitors.confirm(id); res.status(204).end(); });
  // The landing form also says which site sent the visitor and the browser's time zone.
  const LANDING_JS = `fetch('/hi',{method:'POST'}).catch(()=>{});const f=document.getElementById('start');if(f){const set=(n,v)=>{const i=f.querySelector('[name='+n+']');if(i)i.value=v||'';};
try{set('tz',Intl.DateTimeFormat().resolvedOptions().timeZone);}catch{}
try{const r=document.referrer&&new URL(document.referrer);if(r&&r.host!==location.host)set('from',r.origin);}catch{}}`;

  // ---------- landing ----------
  const STAR_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>';
  const CODE_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/></svg>';
  const NAV = '<a class="navlink" href="/how">How it works</a>';
  const FOOT = `<footer class="foot wrap"><p>${esc(PRODUCT_NAME)} is not made by WhatsApp. It&#39;s an unofficial client, so <a href="/privacy">read the risks</a> first.</p><nav><a href="/how">How it works</a><a href="/privacy">Privacy &amp; terms</a><a href="${esc(REPO_URL)}">Open source</a></nav></footer>`;
  const CLOSE = '<section class="close"><div class="wrap"><h2>Go on. Ramble.</h2><a class="cta" href="/#start">Link my WhatsApp</a></div></section>';
  const landing = (req, res, invitedBy = null) => {
    track(req, res);
    refreshStars();
    res.type('html').send(page(res, PRODUCT_NAME, `
<section class="hero wrap">
${invitedBy ? '<span class="invited">A friend invited you.</span>' : ''}
<h1>Ramble, baby.<br><span>It&#39;s handled.</span></h1>
<p class="sub">Every voice note, as text you can read at a glance. Right under the recording.</p>
<form method="post" action="/start" id="start" class="start">
${INVITE_CODE ? '<div><label for="invite">Invite code</label><input type="text" id="invite" name="invite" autocomplete="off" required></div>' : ''}
<input type="hidden" name="consent" value="1"><input type="hidden" name="tz"><input type="hidden" name="from">${invitedBy ? `<input type="hidden" name="ref" value="${esc(invitedBy)}">` : ''}
<button type="submit" class="cta">Link my WhatsApp</button>
<p class="safe"><svg width="15" height="17" viewBox="0 0 15 17" aria-hidden="true"><rect x="1.5" y="7.5" width="12" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 7.5V5a3 3 0 0 1 6 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>Recordings and their text aren&#39;t stored. They pass through, straight to your WhatsApp.</p>
<p class="fine">By continuing you agree to the <a href="/privacy">privacy &amp; terms</a>.</p>
</form>
${DEMO}
</section>
<section class="band"><div class="wrap">
<div class="both">
<div class="lead"><h2>Works both ways.</h2><p>The voice notes you send get text for them. The ones they send get text for you.</p></div>
<div class="say"><span class="me">You ramble. They read.</span><span class="them">They ramble. You read.</span></div>
</div>
<div class="facts"><p><b>Any language.</b> It works out which one on its own.</p><p><b>Nothing kept.</b> A recording is deleted the moment it becomes text.</p></div>
</div></section>
<section class="band"><div class="wrap"><ol class="steps"><li>Link your WhatsApp.</li><li>Send a voice note.</li><li>The text shows up under it.</li></ol></div></section>
<section class="band"><div class="wrap oss">
<div><h2>Open source.</h2><p>Read every line, or run it on your own server.</p></div>
<a class="gh" href="${esc(REPO_URL)}"><span>${CODE_SVG}View on GitHub</span>${stars == null ? '' : `<span>${STAR_SVG}${compact(stars)}</span>`}</a>
</div></section>
${CLOSE}
${FOOT}`, { wide: true, nav: NAV, poll: LANDING_JS }));
  };

  app.get('/', (req, res) => landing(req, res, cookies(req).rref || null));
  // An invite link: the same landing page, remembering who sent it.
  app.get('/i/:code', (req, res) => {
    const code = String(req.params.code || '');
    if (!registry.byInvite(code)) return res.redirect(303, '/');
    res.append('Set-Cookie', `rref=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${req.secure ? '; Secure' : ''}`);
    landing(req, res, code);
  });

  // How it works: the setup, what happens on its own, and everything the control group can do,
  // each command shown as the WhatsApp exchange it really is.
  const voice = (dur, fwd = false) => `<div class="me vn">${fwd ? '<em>Forwarded</em>' : ''}<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1.2v13.6L13 8z" fill="currentColor"/></svg>${WAVE_SVG}<span>${dur}</span></div>`;
  const mini = (where, bubbles) => `<div class="mini" role="img" aria-label="An example exchange in WhatsApp"><small>${where}</small>${bubbles}</div>`;
  const NAME = esc(PRODUCT_NAME);
  // A reply, the way WhatsApp draws one: the quoted message sits inside the bubble, above the answer.
  const quote = (who, text) => `<span class="q"><b>${who}</b>${text}</span>`;
  app.get('/how', (req, res) => track(req, res) ?? res.type('html').send(page(res, `${PRODUCT_NAME} · How it works`, `
<section class="howhero wrap"><h1>How it works.</h1><p class="sub">Set it up once. After that, everything happens inside WhatsApp.</p></section>
<section class="band"><div class="wrap"><ol class="steps long">
<li><div>Link your WhatsApp.<span>Scan a QR code, or on your phone type in a code. In WhatsApp: Settings, Linked devices, Link a device. Same as WhatsApp Web.</span></div></li>
<li><div>Get your ${NAME} group.<span>A new group with only you in it. It&#39;s your control panel.</span></div></li>
<li><div>Record a voice note there.<span>Its text shows up right under it. That&#39;s the whole setup.</span></div></li>
</ol></div></section>
<section class="band"><div class="wrap"><h2>Then it runs itself.</h2>
<div class="facts plain">
<p><b>Your voice notes.</b> Every one you send in a private chat gets its text right under it. In groups, only where you say so.</p>
<p><b>Private chats.</b> Voice notes and videos people send you get their text too.</p>
<p><b>Clean text.</b> Every word they said, with the ums gone and the misheard words fixed.</p>
<p><b>Hands off.</b> View-once media is never touched. In disappearing chats, the text disappears with the recording.</p>
<p><b>Any language.</b> It works out which one on its own.</p>
${DAILY_MINUTES_CAP ? `<p><b>A daily limit.</b> ${DAILY_MINUTES_CAP} minutes of audio a day.</p>` : ''}
</div></div></section>
<section class="band"><div class="wrap"><h2>When you want more.</h2><p class="intro">You run ${NAME} by talking to it, in WhatsApp. Write help in your ${NAME} group for the full list.</p>
<div class="asks">
<div class="ask"><div><h3>Turn on a group.</h3><p>Groups are off until you say so, your own voice notes included. Write include and the group&#39;s name in your ${NAME} group, or forward one voice note from it and reply include. Or write groups mine to transcribe just your own voice notes, in every group. Nothing is ever posted in a group to control it.</p></div>
${mini(`${NAME} group`, `${voice('0:32', true)}<div class="bot"><b>Family</b> is not transcribed. Reply <b>include</b> to start.</div><div class="me">${quote(NAME, 'Family is not transcribed. Reply include to start.')}include</div><div class="bot">Transcribe <b>Family (group)</b>? Reply <b>yes</b> to include it.</div>`)}</div>
<div class="ask"><div><h3>Keep it private.</h3><p>Write private and a chat&#39;s name. Every recording in it, yours included, is transcribed into your ${NAME} group only. Nothing is posted in the chat.</p></div>
${mini(`${NAME} group`, `<div class="me">private Book club</div><div class="bot">Transcribe <b>Book club (group)</b> privately? Reply <b>yes</b> to switch.</div><div class="me">yes</div><div class="bot"><b>Dana</b> in <b>Book club</b><br>I&#39;ll be there in twenty minutes, start without me.</div>`)}</div>
<div class="ask"><div><h3>Take a break.</h3><p>Write pause in your ${NAME} group, and nothing is transcribed anywhere until you write resume.</p></div>
${mini(`${NAME} group`, `<div class="me">pause</div><div class="bot">Paused. Nothing is transcribed until you write <b>resume</b> here.</div>`)}</div>
<div class="ask"><div><h3>Take a text back.</h3><p>Reply delete to any text ${NAME} posted, in any chat. It&#39;s removed for everyone.</p></div>
${mini('Any chat', `<div class="me">I&#39;m stuck in traffic, I&#39;ll be there in about twenty minutes. Start without me.</div><div class="me">${quote('You', 'I&#39;m stuck in traffic, I&#39;ll be there in about twenty minutes.')}delete</div>`)}</div>
<div class="ask"><div><h3>Leave.</h3><p>Write leave in your ${NAME} group. It asks first. Say yes, and it logs the device out of your WhatsApp and erases everything about you here.</p></div>
${mini(`${NAME} group`, `<div class="me">leave</div><div class="bot">Unlink <b>${NAME}</b> from your WhatsApp and erase everything about you here?<br>Reply <b>yes</b> to leave, <b>no</b> to carry on.</div><div class="me">${quote(NAME, `Unlink ${NAME} from your WhatsApp and erase everything`)}yes</div>`)}</div>
</div></div></section>
<section class="band"><div class="wrap"><h2>Nothing kept.</h2>
<div class="facts plain">
<p><b>Recordings.</b> Each one is deleted the moment it becomes text, unless you ask us to keep yours to help improve ${NAME}.</p>
<p><b>Text.</b> It lives in your WhatsApp, under the recording. It is never written to our disk.</p>
</div><p class="intro"><a href="/privacy">Privacy &amp; terms</a> has the details.</p></div></section>
${CLOSE}
${FOOT}`, { wide: true, nav: NAV })));

  app.get('/privacy', (req, res) => track(req, res) ?? res.type('html').send(page(res, `${PRODUCT_NAME} · Privacy & terms`, `
<h1 class="small">Privacy &amp; terms</h1>
<div class="legal">
<section><h3>What ${esc(PRODUCT_NAME)} does</h3>
<p>${esc(PRODUCT_NAME)} is a transcription service: it turns recordings into readable text. In the chats you allow, it sends voice notes and videos to speech and language models, and cleans up what was said into clear text. View-once media is never touched. In disappearing chats, the text disappears on the same timer as the recording.</p>
<p>WhatsApp is only the channel. ${esc(PRODUCT_NAME)} links to your account as a device, like WhatsApp Web, to receive the recordings and post the text back under them, as you, or, for a chat you make private, only into your own private group. It adds nothing to WhatsApp, offers no WhatsApp feature, and is not affiliated with, endorsed by or connected to WhatsApp or Meta. Your WhatsApp account stays yours, under WhatsApp&#39;s own terms.</p></section>
<section><h3>What you pay for</h3>
<p>Any paid plan pays for the transcription: the minutes of audio turned into text, and the model doing it. It is never a charge for WhatsApp, for access to WhatsApp, or for any WhatsApp feature. Those are free from WhatsApp, and ${esc(PRODUCT_NAME)} does not sell or resell them. A recording that cannot be transcribed is not counted.</p></section>
<section><h3>What we keep</h3>
<p>Your WhatsApp session keys. Your settings: which chats are on or off, the language, the names you taught it. The display names of chats and people it has seen, so it can credit a speaker. A short-lived fingerprint of each recording (a hash, not the audio), so a forwarded recording can be matched to its chat. The text of a recording stays in the server&#39;s memory for up to an hour, never on disk, so forwarding the same recording doesn&#39;t transcribe it twice.</p>
<p>When you sign up: the network address it came from, a rough location (from your browser&#39;s language and time zone), the kind of device and browser, and the site that sent you, if any. Only the operator sees these, to spot abuse and to know how people find ${esc(PRODUCT_NAME)}, and they are deleted with your account. The site&#39;s pages also set a cookie holding a random number, to tell a returning browser from a new one: we note the kind of device and the referring site of its first visit, count its visits and sign-ups, and forget it after six months without a visit. It holds nothing else.</p>
<p>Recordings are deleted right after they become text. The one exception: if you explicitly opt in to help improve the product, your recordings and their text are kept for a limited time and then deleted automatically, and what the service did with each one (the text, who a dictated message was matched to, what was sent) is written to the server log so a bad result can be explained. That is off unless you ask for it. Otherwise message text and transcripts are not stored. They exist only in your WhatsApp.</p></section>
<section><h3>What passes through</h3>
<p>As a linked device, every message on your account passes through this server in transit, as it would through WhatsApp Web. Only voice notes and videos in allowed chats are processed. The rest is dropped immediately. Audio, the text and any names in it go to model providers (OpenAI, Groq) under API terms that don&#39;t use your data for training. Server logs hold counts, durations and error codes, never message text, transcripts or names.</p></section>
<section><h3>The risk</h3>
<p>To act as a linked device, ${esc(PRODUCT_NAME)} uses an unofficial WhatsApp client, which is against WhatsApp&#39;s terms of service. In rare cases WhatsApp temporarily or permanently restricts accounts that do this. You link at your own risk: ${esc(PRODUCT_NAME)} cannot prevent, lift or compensate a restriction of your WhatsApp account. If WhatsApp logs the device out or restricts the account, transcription stops until it is linked again, and on a paid plan the unused part of the period is refunded. It is provided as is, without warranty.</p></section>
<section><h3>Leaving</h3>
<p>Write <b>leave</b> in your ${esc(PRODUCT_NAME)} group in WhatsApp and confirm with <b>yes</b>. That logs the device out of your WhatsApp and deletes everything about your account here. You can also remove the device in WhatsApp under Linked devices, at any time.</p></section>
</div>
<a class="back" href="/">Back home</a>`)));

  // ---------- create + link ----------
  app.post('/start', (req, res) => {
    if (startLimiter.blocked(req.ip)) return res.status(429).type('html').send(page(res, 'Slow down', `<h1 class="small">Slow down</h1><p>Too many attempts from this network. Try again in an hour.</p>`));
    startLimiter.hit(req.ip);
    if (req.body.consent !== '1') return res.redirect(303, '/');
    if (INVITE_CODE) {
      const given = Buffer.from(String(req.body.invite || '')), want = Buffer.from(INVITE_CODE);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(403).type('html').send(page(res, 'Invite needed', `<h1 class="small">Invite needed</h1><p>That invite code isn't right. You need one to join ${esc(PRODUCT_NAME)} for now.</p><a class="back" href="/">Back home</a>`));
    }
    // Every account starts on auto-detect; the link page has a selector for the rare case it's needed.
    // Who invited them, if they arrived through someone's /i/<code> link.
    const ref = String(req.body.ref || cookies(req).rref || '');
    let t;
    // The welcome in WhatsApp is written in the browser's language when we have it (Hebrew or English).
    const locale = guessLanguage(req.get('accept-language')) === 'he' ? 'he' : 'en';
    // Who this is, coarsely, for the admin page: the network address, a likely country, the device,
    // where they came from, and whether this browser was here before (see the privacy page).
    const vid = visitors.VISITOR_RE.test(cookies(req).rv || '') ? cookies(req).rv : null;
    const seen = vid ? visitors.get(vid) : null;
    const [prevId, prevKey] = String(cookies(req).rl || '').split('.');
    const prev = prevId && ID_RE.test(prevId) ? registry.get(prevId) : null;
    const tz = String(req.body.tz || '');
    const signup = {
      at: Date.now(), ip: req.ip || null, country: countryOf(req), tz: TZ_RE.test(tz) && tz.length <= 64 ? tz : null,
      device: deviceOf(String(req.get('user-agent') || '')), lang: String(req.get('accept-language') || '').split(',')[0].trim().slice(0, 16) || null,
      from: sourceHost(req.body.from) || null, invited: !!registry.byInvite(ref),
      visitor: vid, visits: seen?.visits || 0, firstSeen: seen?.first || null, earlierAccounts: (seen?.accounts || []).length,
      hadAccount: prev && prevKey && prev.manageKey === prevKey ? prev.id : null,
    };
    try { t = registry.create({ language: '', locale, referredBy: ref, signup }); if (vid) visitors.addAccount(vid, t.id); }
    catch (e) { return res.status(503).type('html').send(page(res, 'Try again soon', `<h1 class="small">Try again soon</h1><p>${esc(e.message)}</p>`)); }
    setSession(req, res, t);
    res.append('Set-Cookie', `rref=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.redirect(303, `/link/${t.id}`);
  });

  // Private-link auth: the key from the URL/body, else from the session cookie.
  function keyFrom(req) {
    const q = req.query.k ?? req.body?.k;
    if (q != null) return String(q);
    const c = cookies(req).rl;
    if (c) { const [id, k] = c.split('.'); if (id === req.params.id) return k || ''; }
    return '';
  }
  function auth(req, res) {
    const id = String(req.params.id || '');
    const t = ID_RE.test(id) ? registry.get(id) : null;
    const k = keyFrom(req);
    const ok = t && KEY_RE.test(k) && KEY_RE.test(t.manageKey) && timingSafeEqual(Buffer.from(k), Buffer.from(t.manageKey));
    if (!ok) { res.status(404).type('html').send(page(res, 'Not found', `<h1 class="small">Not found</h1><p>This link is not valid.</p>`)); return null; }
    return t;
  }

  app.get('/link/:id', (req, res) => {
    const t = auth(req, res); if (!t) return;
    // A key in the URL becomes a cookie and disappears from the address bar.
    if (req.query.k != null) { setSession(req, res, t); return res.redirect(303, `/link/${t.id}`); }
    // A phone cannot scan its own screen: there the default is a code, on a desktop the QR. Either page links to the other.
    const onPhone = /Mobile|Android|iPhone|iPad|iPod/i.test(req.get('user-agent') || '');
    const via = ['qr', 'code'].includes(req.query.via) ? req.query.via : onPhone ? 'code' : 'qr';
    // The number field's country. A number comes from home, not from where the phone is today: a
    // language other than English (he, el…) says the most; the phone's time zone comes next, in the page.
    const firstLang = String(req.get('accept-language') || '').split(',')[0].trim().toLowerCase();
    const country = firstLang && !firstLang.startsWith('en') ? countryFromLanguage(firstLang) : '';
    const region = countryFromLanguage(req.get('accept-language'));
    res.type('html').send(page(res, `${PRODUCT_NAME} · Link your WhatsApp`, `
<canvas id="fx" hidden aria-hidden="true"></canvas>
<div id="box"><span class="pill"><i></i>Starting…</span></div>
<form method="post" action="/link/${t.id}/qr" id="toqr" hidden></form>
<div class="tools">
<form method="post" action="/unlink/${t.id}" id="unlink"><button class="quiet" type="submit">Unlink and erase everything</button><span class="muted">Or write <b>leave</b> in your ${esc(PRODUCT_NAME)} group.</span></form>
</div>
<a class="back" href="/privacy">Privacy &amp; terms</a>`, { poll: `
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const box=()=>document.getElementById('box');const product=${JSON.stringify(PRODUCT_NAME)};
// Into the app itself, where the group is; on a computer, WhatsApp Web.
const openWa=${JSON.stringify(onPhone ? 'whatsapp://' : 'https://web.whatsapp.com/')};
let via='${via}',shown='';
const open='<li>Open WhatsApp and go to <b>Settings</b> (on Android, the <b>&#8942;</b> menu)</li><li>Tap <b>Linked devices</b>, then <b>Link a device</b></li>';
const countries=${JSON.stringify(COUNTRIES)};
const flag=(iso)=>String.fromCodePoint(...[...iso].map(ch=>127397+ch.charCodeAt(0)));
const tz=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){return ''}})();
const home=(countries.find(c=>c[0]==='${country}')||countries.find(c=>c[3].includes(tz))||countries.find(c=>c[0]==='${region}')||countries.find(c=>c[0]===(navigator.language||'').split('-')[1])||countries.find(c=>c[0]==='US'))[0];
// The same rule as the server: + or 00 means as typed; otherwise the country code goes in front of the local form.
function intl(v,cc){const raw=String(v||'').trim();let d=raw.replace(/\\D/g,'');if(raw.startsWith('+')){}else if(d.startsWith('00'))d=d.slice(2);else if(cc&&!(d.startsWith(cc)&&d.length-cc.length>=8&&!d.startsWith('0')))d=cc+(cc==='39'?d:d.replace(/^0/,''));return /^[1-9]\\d{7,14}$/.test(d)?d:null}
function phoneForm(){const opts=countries.map(c=>'<option value="'+c[0]+'"'+(c[0]===home?' selected':'')+'>'+flag(c[0])+' '+esc(c[2])+' (+'+c[1]+')</option>').join('');const h=countries.find(c=>c[0]===home);return '<h1>Link with a code.</h1><form class="phone" method="post" action="/link/${t.id}/code"><label for="phone">Your WhatsApp number</label><div class="tel"><div class="cc"><em id="ccflag">'+flag(h[0])+'</em><span id="ccdial">+'+h[1]+'</span><svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg><select id="ccsel" aria-label="Country">'+opts+'</select></div><input type="hidden" name="cc" id="cc" value="'+h[1]+'"><input type="tel" id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="'+(h[0]==='IL'?'050 123 4567':'Phone number')+'" required></div><p class="hint" id="as"></p><button class="cta" type="submit">Get my code</button></form>';}
function syncPhone(){const sel=document.getElementById('ccsel');if(!sel)return;const c=countries.find(x=>x[0]===sel.value);document.getElementById('ccflag').textContent=flag(c[0]);document.getElementById('ccdial').textContent='+'+c[1];document.getElementById('cc').value=c[1];const ph=document.getElementById('phone');ph.placeholder=c[0]==='IL'?'050 123 4567':'Phone number';const d=intl(ph.value,c[1]);const shown=d?'+'+c[1]+' '+d.slice(c[1].length).replace(/(\\d{2,3})(\\d{3})(\\d{4})$/,'$1 $2 $3'):'';document.getElementById('as').innerHTML=d?'The code will be for <b>'+esc(d.startsWith(c[1])?shown:'+'+d)+'</b>':'';}
document.addEventListener('input',e=>{if(e.target.id==='phone')syncPhone();});
document.addEventListener('change',e=>{if(e.target.id==='ccsel')syncPhone();});
async function copyCode(code,btn){try{await navigator.clipboard.writeText(code);}catch(e){const ta=document.createElement('textarea');ta.value=code;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(_){}ta.remove();}if(btn){btn.textContent='Copied';setTimeout(()=>{btn.textContent='Copy code';},2000);}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;e.preventDefault();copyCode(b.dataset.copy,document.getElementById('copybtn'));});
const swap=(to)=>'<a href="#" class="swap" data-to="'+to+'">'+(to==='qr'?'Scan a QR code instead':'Link with a code instead')+'</a>';
document.addEventListener('click',e=>{const a=e.target.closest('a.swap');if(!a)return;e.preventDefault();if(a.dataset.to==='qr'&&document.body.dataset.code==='1'){document.getElementById('toqr').submit();return;}via=a.dataset.to;shown='';tick();});
document.getElementById('unlink').addEventListener('submit',e=>{if(!confirm('Unlink WhatsApp and erase this account?'))e.preventDefault();});
// Confetti, once, the moment the link goes through — not for someone coming back to a linked account.
let wasLinked=null;
function confetti(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;const c=document.getElementById('fx'),x=c.getContext('2d');c.hidden=false;const W=c.width=innerWidth,H=c.height=innerHeight;const cols=['#25d366','#121212','#d9fdd3','#faf7f2','#1fa855'];const ps=Array.from({length:160},()=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*16-4,r:Math.random()*Math.PI,vr:(Math.random()-.5)*.3,w:6+Math.random()*6,h:8+Math.random()*10,c:cols[Math.random()*cols.length|0]}));const t0=performance.now();(function f(t){const k=(t-t0)/1000;x.clearRect(0,0,W,H);for(const p of ps){p.vy+=.35;p.x+=p.vx;p.y+=p.vy;p.vx*=.99;p.r+=p.vr;x.save();x.translate(p.x,p.y);x.rotate(p.r);x.globalAlpha=Math.max(0,1-Math.max(0,k-2)/1);x.fillStyle=p.c;x.fillRect(-p.w/2,-p.h/2,p.w,p.h);x.restore();}if(k<3.2)requestAnimationFrame(f);else{c.hidden=true;}})(t0);}
let timer=null;
async function tick(){clearTimeout(timer);try{const r=await fetch('/api/link/${t.id}',{credentials:'same-origin'});if(r.ok){render(await r.json());}}catch(e){}timer=setTimeout(tick,2500)}
function render(s){
 document.body.classList.toggle('on',!!s.linkedAt);
 document.body.dataset.code=s.pairByCode?'1':'';
 if(s.mode==='connected'&&wasLinked===false)confetti();
 wasLinked=s.mode==='connected';
 // The same picture is not redrawn: a number being typed must survive the next poll.
 const key=[s.mode,s.pairByCode,s.pairingCode,via==='qr'&&!s.pairByCode&&s.qr?s.qr.slice(-40):'',via,s.rescan,s.controlGroup,s.needsManualGroup].join('|');if(key===shown)return;shown=key;
 if(s.mode==='connected'){box().innerHTML='<span class="pill ok"><i></i>Linked</span><h1>You\\'re in.</h1>'+(s.needsManualGroup?'<p class="go">One thing first: in WhatsApp, create a group with just you in it and post <code>#transcribe</code> there. That becomes your '+esc(product)+' group.</p>':'<p class="go">Your <b>'+esc(s.controlGroup||product)+'</b> group is waiting at the top of your chats. Record a voice note there and watch its text show up right under it.</p>')+'<a class="cta" href="'+openWa+'">Open WhatsApp</a><p class="muted">Everything else happens in that group too: write <b>help</b> there.</p>';}
 else if(s.mode==='qr'&&s.pairingCode){const c=String(s.pairingCode);box().innerHTML='<h1>Your code.</h1><button class="code" type="button" data-copy="'+esc(c)+'" aria-label="Copy the code">'+esc(c.slice(0,4))+'<i>-</i>'+esc(c.slice(4))+'</button><button class="cta" type="button" id="copybtn" data-copy="'+esc(c)+'">Copy code</button><ol class="howto">'+open+'<li>Tap <b>Link with phone number instead</b></li><li>Paste the code</li></ol><p class="muted">WhatsApp may also send a notification asking for the code; tapping it is a shortcut. The code is good for a few minutes, and a fresh one appears here when it expires.</p>'+swap('qr');}
 else if(s.mode==='qr'&&s.pairByCode){box().innerHTML='<span class="pill"><i></i>Getting you a code…</span>'+swap('qr');}
 else if(s.mode==='qr'&&via==='code'){box().innerHTML=phoneForm()+swap('qr');}
 else if(s.qr){box().innerHTML='<h1>Scan this.</h1><ol class="howto">'+open+'<li>Point your phone at this code</li></ol><img class="qr" src="'+esc(s.qr)+'" alt="QR code">'+(s.rescan?'<p class="go center">Your phone said it couldn\\'t link? Scan this one again. WhatsApp changed the code after the first scan.</p>':'<p class="muted center">The code refreshes on its own.</p>')+swap('code');}
 else if(s.mode==='logged_out'){box().innerHTML='<span class="pill"><i></i>Logged out</span><p>WhatsApp logged this device out. A new code is coming…</p>';}
 else{box().innerHTML='<span class="pill"><i></i>'+(s.mode==='reconnecting'?'Reconnecting…':'Preparing your code…')+'</span>';}
}
tick();` }));
  });

  app.get('/api/link/:id', (req, res) => { const t = auth(req, res); if (t) res.json(t.status({ full: true })); });

  // Link with a code: the number stays with the account until it is linked or the QR is chosen again.
  app.post('/link/:id/code', async (req, res) => {
    const t = auth(req, res); if (!t) return;
    // The number as typed (local, or with + / 00) and the country picked next to it.
    const phone = normalizePhone(req.body.phone, req.body.cc);
    if (!phone) return res.status(400).type('html').send(page(res, 'Not a number', `<h1 class="small">That doesn&#39;t look like a number.</h1><p>Type your WhatsApp number the way you&#39;d give it to a friend, and check the country next to it.</p><a class="back" href="/link/${t.id}?via=code">Back</a>`));
    await t.requestPairingCode(phone);
    res.redirect(303, `/link/${t.id}`);
  });
  app.post('/link/:id/qr', (req, res) => {
    const t = auth(req, res); if (!t) return;
    t.usePairingQr();
    res.redirect(303, `/link/${t.id}?via=qr`);
  });

  app.post('/unlink/:id', async (req, res) => {
    const t = auth(req, res); if (!t) return;
    const r = await registry.remove(t.id);
    clearSession(req, res);
    res.type('html').send(page(res, 'Unlinked', `<h1 class="small">Gone.</h1><p>Nothing of yours is left here.${r?.loggedOut ? ' The device was logged out of your WhatsApp.' : ' WhatsApp did not confirm the logout, so remove the device yourself under <b>WhatsApp → Linked devices</b>.'} The <b>${esc(PRODUCT_NAME)}</b> group stays in your WhatsApp; delete it whenever you like.</p><a class="back" href="/">Start over</a>`));
  });

  // ---------- admin (health only; support endpoints below) ----------
  function adminAuth(req, res, next) {
    if (!ADMIN_PASSWORD) return res.status(404).end();
    if (adminFailLimiter.blocked(req.ip)) return res.status(429).type('text').send('Too many failed attempts. Try again later.');
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    let ok = false;
    if (scheme === 'Basic' && b64) {
      const given = Buffer.from(Buffer.from(b64, 'base64').toString('utf8').split(':').slice(1).join(':'));
      const want = Buffer.from(ADMIN_PASSWORD);
      ok = given.length === want.length && timingSafeEqual(given, want);
    }
    if (ok) { const v = cookies(req).rv; if (visitors.VISITOR_RE.test(v || '')) visitors.markStaff(v); return next(); }
    adminFailLimiter.hit(req.ip);
    console.warn(`🔐 admin sign-in failed from ${req.ip} (${String(req.get('x-forwarded-for') || '').split(',').length} forwarded hop(s))`);
    res.set('WWW-Authenticate', `Basic realm="${PRODUCT_NAME} admin"`); res.status(401).send('Authentication required');
  }
  const overview = () => {
    const ts = registry.list().map((t) => ({ ...t.status({ history: true }), signup: registry.signupOf(t), expiresAt: t.linkedAt ? null : t.createdAt + registry.UNLINKED_TTL_MIN * 60e3 }));
    return {
      product: PRODUCT_NAME, accounts: ts.length, connected: ts.filter((t) => t.ready).length,
      pending: registry.pendingCount(), max: registry.MAX_TENANTS, dataMounted: dataDirIsMount(),
      budget: { serverMinutesToday: Math.round(secondsToday() / 60), serverDailyMinutes: GLOBAL_DAILY_MINUTES || null, perAccountDailyMinutes: DAILY_MINUTES_CAP || null },
      tenants: ts,
    };
  };
  app.get('/admin.json', adminAuth, (_req, res) => res.json(overview()));
  // Support: (re)create an account's control group — e.g. the user deleted it.
  // ?test=1 only proves group creation works on this account (creates "<name> (test)"
  // and leaves it again) without touching the real control group. Runs in the
  // background; poll GET /admin/control-group/:id/test for the outcome.
  app.post('/admin/control-group/:id', adminAuth, async (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    if (!t.ready || !t.sock) return res.status(409).json({ error: 'account not connected' });
    if (req.query.test === '1') {
      const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
      t.groupTest = { startedAt: Date.now(), state: 'running' };
      (async () => {
        try {
          const g = await withTimeout(t.sock.groupCreate(`${PRODUCT_NAME} (test)`, []), 45000, 'groupCreate');
          let left = false;
          try { await withTimeout(t.sock.groupLeave(g.id), 20000, 'groupLeave'); left = true; } catch { /* reported below */ }
          t.groupTest = { ...t.groupTest, state: 'ok', participants: (g.participants || []).length, leftAgain: left, ms: Date.now() - t.groupTest.startedAt };
        } catch (e) {
          t.groupTest = { ...t.groupTest, state: 'failed', error: String(e?.message || e).split('\n')[0], ms: Date.now() - t.groupTest.startedAt };
        }
      })();
      return res.status(202).json({ started: true });
    }
    if (t.target && req.query.force !== '1') return res.status(409).json({ error: 'account already has a control group; add ?force=1 to create another' });
    await t.createControlGroup();
    res.json(t.status());
  });
  app.get('/admin/control-group/:id/test', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    res.json(t.groupTest || { state: 'never run' });
  });
  // Support: which transcription provider an account uses — "free" (cheap model)
  // or "pro" (the better one). POST /admin/plan/<id>?plan=pro
  app.post('/admin/plan/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const plan = String(req.query.plan || req.body?.plan || '');
    if (!t.setPlan(plan)) return res.status(400).json({ error: `plan must be one of ${PLANS.join(', ')}` });
    res.json({ id: t.id, plan: t.plan, model: planLabel(t.plan) });
  });
  // Support: set an account's transcription language ('' = auto-detect), e.g. to
  // release an account that an older version locked to one language.
  // POST /admin/language/<id>?code=he   (empty = auto)
  app.post('/admin/language/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const code = String(req.query.code ?? req.body?.code ?? '');
    if (!LANGUAGES.some(([v]) => v === code)) return res.status(400).json({ error: `code must be one of ${LANGUAGES.map(([v]) => v || "''").join(', ')}` });
    t.setLanguage(code);
    res.json({ id: t.id, language: t.language || 'auto' });
  });
  // Support: also transcribe this account's recordings with other models, to
  // compare them on real audio. Up to four, comma-separated; the readings are
  // posted into the owner's own control group, never logged.
  // POST /admin/ab/<id>?model=gpt-4o-transcribe,whisper-large-v3-turbo   (empty = off)
  app.post('/admin/ab/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const raw = String(req.query.model ?? req.body?.model ?? '');
    if (raw && !/^[\w.,/-]{1,120}$/.test(raw)) return res.status(400).json({ error: 'model names may contain letters, digits, dot, dash, slash and commas' });
    t.setAbModel(raw);
    res.json({ id: t.id, abModels: t.abModel ? t.abModel.split(',').map((s) => s.trim()).filter(Boolean) : [] });
  });
  // Opt-in, per account, not in the user-facing UI: keep this account's recordings
  // (with what the models made of them) to improve the product.
  // POST /admin/keep-audio/<id>?on=1|0
  app.post('/admin/keep-audio/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const on = /^(1|true|on|yes)$/i.test(String(req.query.on ?? req.body?.on ?? ''));
    t.setKeepAudio(on);
    res.json({ id: t.id, keepAudio: t.keepAudio, keepDays: research.RESEARCH_KEEP_DAYS, maxMb: research.RESEARCH_MAX_MB });
  });
  // What is kept for one account: metadata and the transcripts, newest first.
  app.get('/admin/research/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    res.json({ id: t.id, keepAudio: t.keepAudio, usage: research.usage(), items: research.list(t.id).slice(0, Number(req.query.limit) || 50) });
  });
  // One kept recording, as audio. Admin only, and only ever for an account that opted in.
  app.get('/admin/research/:id/:item', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    const p = research.audioPath(t.id, String(req.params.item));
    if (!p) return res.status(404).json({ error: 'no such recording' });
    res.sendFile(p);
  });
  // Support: hand an owner who lost their private link a fresh one (the old one stops working).
  app.post('/admin/link/:id', adminAuth, (req, res) => {
    const t = registry.get(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'no such account' });
    registry.rotateKey(t);
    res.json({ id: t.id, label: t.label, link: `${req.protocol}://${req.get('host')}/link/${t.id}?k=${t.manageKey}` });
  });
  app.get('/admin', adminAuth, (req, res) => {
    res.type('html').send(page(res, `${PRODUCT_NAME} · admin`, adminPage(overview(), res.locals.nonce, FUNNEL_PERIODS.some(([d]) => String(d) === req.query.days) ? Number(req.query.days) : 30), { wide: true, nav: '<a class="navlink" href="/admin.json">JSON</a>', poll: ADMIN_JS }));
  });

  // Liveness only. Counts and details are behind the admin password.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  return app;
}
