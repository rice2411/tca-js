/**
 * tca-js — unofficial TikTok Chat API (speaks the TikTok Web protocol).
 *
 * ```ts
 * const api = await new TikTok().login({ cookies, deviceId });
 * api.listener.on('message', async (msg) => {
 *   if (msg.isSelf) return;
 *   await api.sendMessage(msg, 'Got it, thanks!');
 * });
 * api.listener.start();
 * ```
 *
 * Getting cookies the first time: `loginQR({ onEvent })` — opens headless Chrome on TikTok's QR page
 * (the login API requires a JS signature so it can't be done in pure Node), returns cookies after scanning. See README.
 */
export { TikTok } from './client';
export { API } from './api/api';
export type { SendResult } from './api/api';
export { MessageType } from './protocol/constants';
export { TikTokError } from './errors';
export type { TikTokErrorCode } from './errors';
export { Listener, MANUAL_CLOSE } from './listener/listener';
export type { ListenerEvents } from './listener/listener';
export { loginQR } from './auth/qr-login';
export type { QrLoginEvent, QrLoginOptions } from './auth/qr-login';
export { findChrome } from './auth/chrome';
export type * from './models/types';
