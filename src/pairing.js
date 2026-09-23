/**
 * Pairing, on top of Baileys: the QR it shows, the code it hands out, and one
 * step of the flow it does not know.
 *
 * Since late July 2026 WhatsApp may answer a scan with a `companion_reg_refresh`
 * notification instead of pair-success: the phone wants the companion's adv
 * secret rotated and the QR shown again with the new one (same ref). Baileys
 * 7.0.0-rc14 ignores the notification, keeps rotating QRs signed with the old
 * secret, and the phone says "couldn't link, check your connection". So every
 * QR passes through here and always carries the *current* secret, and the
 * notification rotates it and is acknowledged, as WhatsApp Web does.
 * (WhiskeySockets/Baileys#2737, PRs #2765 and #2749.)
 *
 * Pure parts are exported for tests; attach() wires a socket.
 */
import { randomBytes } from 'node:crypto';

/** A QR is "ref,noiseKey,identityKey,advSecret": the same one, with the secret in use now. */
export const withAdvSecret = (qr, advB64) => { const f = String(qr).split(','); return f.length === 4 ? [f[0], f[1], f[2], advB64].join(',') : qr; };
export const refOf = (qr) => String(qr).split(',')[0];

/** A fresh adv secret, persisted through Baileys' own creds.update. */
export function rotateAdvSecret(sock) {
  sock.authState.creds.advSecretKey = randomBytes(32).toString('base64');
  sock.ev.emit('creds.update', sock.authState.creds);
  return sock.authState.creds.advSecretKey;
}

/**
 * Wire one socket. onQr gets every QR to show (already carrying the current
 * secret); log lines say how far a pairing got, never what was in it.
 */
export function attach(sock, { onQr, onRefresh, tag = '', log = console.log } = {}) {
  let lastQr = null;
  const show = (qr) => { lastQr = withAdvSecret(qr, sock.authState.creds.advSecretKey); onQr?.(lastQr); };
  sock.ev.on('connection.update', (u) => { if (u.qr) show(u.qr); });
  sock.ws.on('CB:iq,type:set,pair-device', () => log(`${tag} 🔗 pairing offered — waiting for a scan or a code`));
  sock.ws.on('CB:notification,type:companion_reg_refresh', async (node) => {
    rotateAdvSecret(sock);
    if (lastQr) show(refOf(lastQr) + lastQr.slice(lastQr.indexOf(',')));
    // WhatsApp Web answers with an ack; Baileys' own ack fails before login (it needs creds.me),
    // so it is sent from here, unless the account is registered and Baileys can do it.
    let acked = false;
    if (!sock.authState.creds.me && node?.attrs?.id) {
      try { await sock.sendNode({ tag: 'ack', attrs: { id: node.attrs.id, to: node.attrs.from || 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' } }); acked = true; }
      catch (e) { log(`${tag} refresh ack failed: ${e?.message || e}`); }
    }
    log(`${tag} 🔁 WhatsApp asked for a refreshed pairing — new secret, same code${acked ? ', acknowledged' : ''}`);
    onRefresh?.();
  });
  sock.ws.on('CB:iq,,pair-success', () => log(`${tag} 📱 scanned — finishing the pairing`));
  return { get lastQr() { return lastQr; } };
}

/** Digits only, with the country code; null when it cannot be a phone number. */
export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
