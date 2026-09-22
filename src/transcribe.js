import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

/**
 * Speech-to-text via any OpenAI-compatible /audio/transcriptions endpoint.
 * Handles voice notes AND videos — for videos the audio track is extracted with
 * ffmpeg first (small + robust) instead of uploading the whole clip.
 *
 * Two providers, chosen per account by its plan:
 *   pro   TRANSCRIBE_API_KEY / _BASE_URL / _MODEL / _LANGUAGE        (e.g. OpenAI)
 *   free  FREE_TRANSCRIBE_API_KEY / _BASE_URL / _MODEL               (e.g. Groq)
 *         (SHADOW_TRANSCRIBE_* are still read, for older deployments)
 *
 * A `pro` account falls back to the free provider only when its own provider
 * fails (quota, outage) — one extra call in the rare bad case, nothing on the
 * happy path. `free` accounts never reach the paid provider.
 *
 * Everything for one recording happens inside a single prepared-audio scope, so
 * ffmpeg runs once even when a comparison run or a retry is involved.
 */
const PRO = {
  plan: 'pro',
  apiKey: process.env.TRANSCRIBE_API_KEY || process.env.GROQ_API_KEY || process.env.LLM_API_KEY,
  baseUrl: process.env.TRANSCRIBE_BASE_URL || process.env.WHISPER_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.TRANSCRIBE_MODEL || process.env.WHISPER_MODEL || 'whisper-large-v3',
  language: process.env.TRANSCRIBE_LANGUAGE || process.env.WHISPER_LANGUAGE || '',
};
const FREE = {
  plan: 'free',
  apiKey: process.env.FREE_TRANSCRIBE_API_KEY || process.env.SHADOW_TRANSCRIBE_API_KEY || '',
  baseUrl: process.env.FREE_TRANSCRIBE_BASE_URL || process.env.SHADOW_TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.FREE_TRANSCRIBE_MODEL || process.env.SHADOW_TRANSCRIBE_MODEL || 'whisper-large-v3',
  language: process.env.FREE_TRANSCRIBE_LANGUAGE ?? (process.env.TRANSCRIBE_LANGUAGE || ''),
};
const REQUEST_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 60_000);
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 120_000);
const MAX_AUDIO_SECONDS = 4 * 3600;

export const PLANS = ['free', 'pro'];
const configFor = (plan) => (plan === 'free' ? FREE : PRO);
export const planEnabled = (plan) => Boolean(configFor(plan).apiKey);
export const transcribeEnabled = planEnabled('pro') || planEnabled('free');
export const planLabel = (plan) => (planEnabled(plan) ? configFor(plan).model : 'not configured');
export const planLanguage = (plan) => configFor(plan).language; // forced language ('' = auto)
// Kept for older call sites / logs.
export const primaryLabel = PRO.model;
export const transcribeLanguage = PRO.language;

const AUDIO_MIME = {
  ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', amr: 'audio/amr', aac: 'audio/aac',
};

function ffmpegBin() {
  // Prefer the bundled ffmpeg (ffmpeg-static) so no system install is needed.
  const cands = [process.env.FFMPEG_PATH, ffmpegStatic, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter(Boolean);
  for (const c of cands) { if (c === 'ffmpeg') return c; if (existsSync(c)) return c; }
  return 'ffmpeg';
}

// Extract a small 16kHz mono mp3 audio track from a video. Returns temp path or null.
function extractAudio(videoPath) {
  return new Promise((resolve) => {
    const out = join(tmpdir(), `wa_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
    // Local file in, local file out, nothing else: no network protocols, no stdin,
    // and a hard time limit so a malformed clip can't pin a core forever.
    const ff = spawn(ffmpegBin(), ['-nostdin', '-y', '-protocol_whitelist', 'file', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-t', String(MAX_AUDIO_SECONDS), '-f', 'mp3', out], { stdio: 'ignore' });
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, FFMPEG_TIMEOUT_MS);
    const done = (ok) => { clearTimeout(timer); if (!ok) { try { unlinkSync(out); } catch { /* none */ } } resolve(ok ? out : null); };
    ff.on('error', () => done(false));
    ff.on('close', (code) => done(code === 0 && existsSync(out)));
  });
}

/**
 * How long the recording really is, in seconds, by decoding its audio track. The length a
 * message declares is written by the sender's client and can say anything; the quota and
 * the per-recording limit must be held against the audio itself. Decoding stops just past
 * `limitSeconds`, so an over-long file costs no more than a limit-long one.
 * Returns null when ffmpeg could not tell (not installed, not decodable, timed out).
 */
export function measureSeconds(absPath, { limitSeconds = MAX_AUDIO_SECONDS, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegBin(), ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file', '-i', absPath, '-vn', '-t', String(limitSeconds + 1), '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    ff.stderr.on('data', (c) => { tail = (tail + c).slice(-4000); });
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const done = (ok) => {
      clearTimeout(timer);
      const times = ok ? [...tail.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)] : [];
      const last = times[times.length - 1];
      resolve(last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null);
    };
    ff.on('error', () => done(false));
    ff.on('close', (code) => done(code === 0));
  });
}

// Never throws: returns the file to transcribe, plus a cleanup.
async function prepareAudio(absPath, isVideo) {
  if (!isVideo) return { path: absPath, cleanup: () => {} };
  const extracted = await extractAudio(absPath);
  if (!extracted) return { path: absPath, cleanup: () => {} }; // fall back to the raw clip
  return { path: extracted, cleanup: () => { try { unlinkSync(extracted); } catch { /* ignore */ } } };
}

function combineSignals(signal, timeoutMs) {
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new Error('timeout')), timeoutMs);
  const signals = [own.signal, ...(signal ? [signal] : [])];
  const combined = signals.length > 1 && AbortSignal.any ? AbortSignal.any(signals) : own.signal;
  return { signal: combined, done: () => clearTimeout(timer) };
}

async function postTranscription(absPath, cfg, { language, model, signal } = {}) {
  const ext = absPath.split('.').pop().toLowerCase();
  const buf = readFileSync(absPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: AUDIO_MIME[ext] || 'audio/mpeg' }), basename(absPath));
  form.append('model', model || cfg.model);
  form.append('response_format', 'text');
  const lang = language === undefined ? cfg.language : language;
  if (lang) form.append('language', lang);

  const { signal: sig, done } = combineSignals(signal, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST', signal: sig,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      // Never carry the provider's response body into logs or status: it may echo
      // the request. Status plus a machine code is all anyone needs.
      const body = await res.text().catch(() => '');
      let code = ''; try { const j = JSON.parse(body); code = j?.error?.code || j?.error?.type || ''; } catch { /* not json */ }
      throw new Error(`${model || cfg.model} HTTP ${res.status}${code ? ` (${String(code).slice(0, 40)})` : ''}`);
    }
    return (await res.text()).trim();
  } finally {
    done();
  }
}

/**
 * Transcribe one recording for one account.
 *
 * @param {object} o
 * @param {string} o.absPath            downloaded media
 * @param {boolean} o.isVideo
 * @param {'free'|'pro'} o.plan         which provider to use
 * @param {string} [o.language]         '' = auto-detect; undefined = provider default
 * @param {(text:string, ctx:{language:string})=>{ok:boolean,reason?:string}} [o.validate]
 *        sanity gate; a failure on a forced language triggers one auto-detect retry
 * @param {string|string[]} [o.compareModels]  also transcribe with these models, for a comparison
 *        (a comma-separated string is fine; a `whisper*` model is sent to the free
 *        provider, anything else to this account's own provider)
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{text:string, model:string, check:object, language:string,
 *                    usedFallback:boolean, compare:{model:string,text:string}[]}>}
 */
export async function transcribeRun({ absPath, isVideo = false, plan = 'pro', language, validate, compareModels = null, signal }) {
  const cfg = configFor(plan);
  if (!cfg.apiKey) throw new Error(`no transcription provider for the ${plan} plan`);
  const fallback = plan === 'pro' && FREE.apiKey && FREE.baseUrl !== PRO.baseUrl ? FREE : null;
  const wanted = (Array.isArray(compareModels) ? compareModels : String(compareModels || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
  const { path, cleanup } = await prepareAudio(absPath, isVideo);
  try {
    // Each comparison goes to the provider that actually serves that model.
    const comparePromise = Promise.all(wanted.map(async (model) => {
      const host = /^whisper/i.test(model) ? FREE : cfg;
      if (!host.apiKey) return null;
      const text = await postTranscription(path, host, { language, model, signal }).catch(() => null);
      return text ? { model, text } : null;
    })).then((rs) => rs.filter(Boolean));

    let model = cfg.model, usedFallback = false, text;
    try {
      text = await postTranscription(path, cfg, { language, signal });
    } catch (e) {
      if (!fallback) { await comparePromise; throw e; }
      // The account's own provider is down: one attempt on the other one, so a
      // recording is never lost to an outage or an exhausted balance.
      text = await postTranscription(path, fallback, { language, signal });
      model = fallback.model; usedFallback = true;
    }

    const lang = language === undefined ? cfg.language : language;
    let check = validate ? validate(text, { language: lang }) : { ok: true };
    if (!check.ok && lang && validate) {
      // A forced language on a recording in another language yields junk; retry
      // once letting the model decide, inside the same prepared-audio scope.
      const alt = await postTranscription(path, usedFallback ? fallback : cfg, { language: '', signal }).catch(() => null);
      const altCheck = alt ? validate(alt, { language: '' }) : { ok: false, reason: 'empty' };
      if (altCheck.ok) { text = alt; check = altCheck; }
      else check = { ok: false, reason: `${check.reason}; auto-detect: ${altCheck.reason}` };
    }

    return { text, model, check, language: lang, usedFallback, compare: await comparePromise };
  } finally {
    cleanup();
  }
}
