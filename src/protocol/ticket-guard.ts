import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { TicketGuard } from '../models/types';

/**
 * TikTok "ticket guard" — request signing the web client applies to `message/send` (enforced since 12/11/2026: a
 * session that sends unsigned gets its sends blocked after the first one, gateway JSON `status_code: 7`).
 *
 * At login the page generates an EC P-256 key pair, registers the public key, and the server hands back a `ticket` +
 * `ts_sign` (response header `tt-ticket-guard-server-data`). Each signed request then carries:
 *
 *   req_sign = base64(DER(ECDSA-SHA256(privateKey, "ticket=<ticket>&path=<path>&timestamp=<unix s>")))
 *   tt-ticket-guard-client-data = base64(JSON {ts_sign, req_content: "ticket,path,timestamp", req_sign, timestamp})
 *   tt-ticket-guard-public-key  = base64(uncompressed public point, 65 bytes)
 *
 * X-Gnarly / X-Dynosaur (also sent by the web client) are not required — tested 12/11/2026.
 */

/** IM paths the web client signs. */
export const SIGNED_PATHS = new Set(['/v1/message/send']);

/** Headers for one signed request. */
export function ticketGuardHeaders(guard: TicketGuard, path: string, now: number = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  const message = `ticket=${guard.ticket}&path=${path}&timestamp=${timestamp}`;
  const reqSign = sign('sha256', Buffer.from(message), createPrivateKey(guard.privateKey)).toString('base64');
  const clientData = { ts_sign: guard.tsSign, req_content: 'ticket,path,timestamp', req_sign: reqSign, timestamp };
  return {
    'tt-ticket-guard-client-data': Buffer.from(JSON.stringify(clientData)).toString('base64'),
    'tt-ticket-guard-public-key': publicPoint(guard.publicKey),
    'tt-ticket-guard-version': '2',
    'tt-ticket-guard-web-version': '1',
    'tt-ticket-guard-iteration-version': '0',
  };
}

/** PEM public key → base64 of the uncompressed point (`04 || x || y`). */
function publicPoint(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? '', 'base64url'),
    Buffer.from(jwk.y ?? '', 'base64url'),
  ]).toString('base64');
}

/**
 * Evaluated in a logged-in tiktok.com page: reads the security SDK's IndexedDB store (`secure-store`). The key pair is
 * stored as plain PEM; the ticket is AES-GCM encrypted with a key PBKDF2-derived from a constant
 * (`"tt-ticket-guard-iv"`, salt `"secure-salt"`). Resolves `null` until the SDK has stored a ticket.
 */
export const READ_TICKET_GUARD_JS = `(async () => {
  try {
    const db = await new Promise((ok, ko) => { const r = indexedDB.open('secure-store'); r.onsuccess = () => ok(r.result); r.onerror = ko; });
    if (!db.objectStoreNames.contains('cryptvalues')) return null;
    const get = (k) => new Promise((ok) => { const q = db.transaction('cryptvalues').objectStore('cryptvalues').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); });
    const keysRaw = await get('security-sdk/s_sdk_crypt_sdk');
    const signRaw = await get('security-sdk/s_sdk_sign_data_key/tt_fetch');
    if (!keysRaw || !signRaw) return null;
    const keys = JSON.parse(JSON.parse(keysRaw).data);
    const signData = JSON.parse(JSON.parse(signRaw).data);
    if (!keys.ec_privateKey || !keys.ec_publicKey || !signData.ts_sign || !signData.encrypt_ticket) return null;
    const te = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', te.encode('tt-ticket-guard-iv'), 'PBKDF2', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('secure-salt'), iterations: 1000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 128 }, false, ['decrypt']);
    const enc = Uint8Array.from(atob(signData.encrypt_ticket), (c) => c.charCodeAt(0));
    const ticket = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.slice(0, 12) }, aes, enc.slice(12)));
    return { privateKey: keys.ec_privateKey, publicKey: keys.ec_publicKey, tsSign: signData.ts_sign, ticket };
  } catch (e) {
    return null;
  }
})()`;

/** Shape check for a value read back from storage / the page. */
export function isTicketGuard(v: unknown): v is TicketGuard {
  const g = v as Partial<TicketGuard> | null;
  return (
    !!g &&
    typeof g.privateKey === 'string' &&
    typeof g.publicKey === 'string' &&
    typeof g.tsSign === 'string' &&
    typeof g.ticket === 'string' &&
    g.ticket.length > 0
  );
}
