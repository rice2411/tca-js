import { createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Cmd, IMAGEX_REGION, IMAGEX_SERVICE, IMAGEX_VERSION } from '../protocol/constants';
import type { Context } from '../protocol/context';
import { TikTokError } from '../errors';
import type { ImageInput, TikTokImage } from '../models/types';

/** Temporary STS credentials for the image store — obtained via IM command `UploadConfig`, valid ~10 minutes. */
interface UploadCredential {
  serviceId: string;
  host: string;
  accessKeyId: string;
  sessionToken: string;
  secretAccessKey: string;
  /** ms epoch */
  expiresAt: number;
}

/** Uploaded image, encrypted by the store — enough to send an image message. */
export interface UploadedImage {
  uri: string;
  secretKey: string;
  width: number;
  height: number;
  size: number;
  filename: string;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class MediaClient {
  private cred: UploadCredential | null = null;

  constructor(private readonly ctx: Context) {}

  /** `UploadConfig` returns two credential sets: type 1 = ImageX (images), type 2 = VOD (video). Use type 1. */
  private async credential(): Promise<UploadCredential> {
    if (this.cred && this.cred.expiresAt - Date.now() > 60_000) return this.cred;
    const body = await this.ctx.im('/v1/media/upload_config', Cmd.UploadConfig, Buffer.alloc(0));
    const c = body.msgs(1).find((m) => m.num(1) === 1);
    if (!c) throw new TikTokError('UPLOAD_FAILED', 'upload_config has no ImageX credentials');
    this.cred = {
      serviceId: c.str(2),
      host: c.str(3),
      expiresAt: c.num(4),
      accessKeyId: c.str(6),
      sessionToken: c.str(7),
      secretAccessKey: c.str(8),
    };
    return this.cred;
  }

  /** Call ImageX signed with AWS SigV4 (region cn-north-1, service imagex). */
  private async imagex<T>(method: 'GET' | 'POST', params: Record<string, string>, body?: string): Promise<T> {
    const c = await this.credential();
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const date = amzDate.slice(0, 8);
    const query = Object.keys(params)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
      .join('&');
    const headers: Record<string, string> = { 'x-amz-date': amzDate, 'x-amz-security-token': c.sessionToken };
    if (body !== undefined) headers['x-amz-content-sha256'] = sha256(body);
    const signed = Object.keys(headers).sort();
    const canonical = [
      method,
      '/',
      query,
      signed.map((k) => `${k}:${headers[k]}\n`).join(''),
      signed.join(';'),
      body !== undefined ? headers['x-amz-content-sha256'] : sha256(''),
    ].join('\n');
    const scope = `${date}/${IMAGEX_REGION}/${IMAGEX_SERVICE}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    let k = hmac(`AWS4${c.secretAccessKey}`, date);
    k = hmac(k, IMAGEX_REGION);
    k = hmac(k, IMAGEX_SERVICE);
    k = hmac(k, 'aws4_request');
    const signature = createHmac('sha256', k).update(toSign).digest('hex');
    const res = await fetch(`https://${c.host}/?${query}`, {
      method,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: AbortSignal.timeout(this.ctx.options.timeoutMs ?? 20_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ResponseMetadata?: { Error?: { Message?: string; CodeN?: number } };
    } | null;
    const err = json?.ResponseMetadata?.Error;
    if (!res.ok || !json || err) {
      throw new TikTokError(
        'UPLOAD_FAILED',
        `imagex ${params.Action}: ${err?.Message ?? `HTTP ${res.status}`}`,
        err?.CodeN ?? res.status,
      );
    }
    return json as T;
  }

  /**
   * Upload an image to the private message store: Apply → POST file → Commit (the store encrypts with AES-GCM
   * and returns the key). Image dimensions come from the Commit result — no need to decode the image.
   */
  async upload(image: ImageInput): Promise<UploadedImage> {
    const c = await this.credential();
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(image.filename)?.[1] ?? 'jpg').toLowerCase();
    type Apply = {
      Result: {
        UploadAddress: { StoreInfos: { StoreUri: string; Auth: string }[]; UploadHosts: string[]; SessionKey: string };
      };
    };
    const apply = await this.imagex<Apply>('GET', {
      Action: 'ApplyImageUpload',
      Version: IMAGEX_VERSION,
      ServiceId: c.serviceId,
      FileSize: String(image.data.length),
      FileExtension: `.${ext}`,
      s: randomBytes(6).toString('hex').slice(0, 10),
    });
    const addr = apply.Result.UploadAddress;
    const store = addr.StoreInfos[0];
    const host = addr.UploadHosts[0];
    if (!store || !host) throw new TikTokError('UPLOAD_FAILED', 'ApplyImageUpload returned no upload target');

    const up = await fetch(`https://${host}/upload/v1/${store.StoreUri}`, {
      method: 'POST',
      headers: {
        Authorization: store.Auth,
        'Content-CRC32': (crc32(image.data) >>> 0).toString(16).padStart(8, '0'),
        // Without this header the store returns 4004 Not Found.
        'X-Storage-U': this.ctx.ownId,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="undefined"',
      },
      body: new Uint8Array(image.data),
      signal: AbortSignal.timeout(this.ctx.options.timeoutMs ?? 60_000),
    });
    const upJson = (await up.json().catch(() => null)) as { code?: number; message?: string } | null;
    if (!up.ok || upJson?.code !== 2000) {
      throw new TikTokError(
        'UPLOAD_FAILED',
        `upload: ${upJson?.message ?? `HTTP ${up.status}`}`,
        upJson?.code ?? up.status,
      );
    }

    type Commit = {
      Result: {
        Results: { Encryption?: { Uri: string; SecretKey: string; Extra?: Record<string, string> } }[];
        PluginResult?: { ImageWidth?: number; ImageHeight?: number; ImageSize?: number }[];
      };
    };
    const commit = await this.imagex<Commit>(
      'POST',
      { Action: 'CommitImageUpload', Version: IMAGEX_VERSION, ServiceId: c.serviceId },
      JSON.stringify({
        SessionKey: addr.SessionKey,
        Functions: [{ name: 'Encryption', input: { Config: { copies: 'cipher_v2' } } }],
      }),
    );
    const enc = commit.Result.Results?.[0]?.Encryption;
    const plugin = commit.Result.PluginResult?.[0];
    if (!enc?.Uri || !enc.SecretKey)
      throw new TikTokError('UPLOAD_FAILED', 'CommitImageUpload returned no encrypted result');
    return {
      uri: enc.Uri,
      secretKey: enc.SecretKey,
      width: plugin?.ImageWidth ?? Number(enc.Extra?.img_width ?? 0),
      height: plugin?.ImageHeight ?? Number(enc.Extra?.img_height ?? 0),
      size: plugin?.ImageSize ?? image.data.length,
      filename: image.filename,
    };
  }

  /** Download and decrypt a message image. Layout: 12-byte IV ‖ ciphertext ‖ 16-byte tag. */
  async download(image: TikTokImage, which: 'origin' | 'thumb' = 'origin'): Promise<Buffer> {
    const url = which === 'thumb' && image.thumbUrl ? image.thumbUrl : image.url;
    if (!url) throw new TikTokError('DOWNLOAD_FAILED', 'Image has no URL');
    const res = await this.ctx.fetch(url);
    if (!res.ok) throw new TikTokError('DOWNLOAD_FAILED', `Image download: HTTP ${res.status}`, res.status);
    const enc = Buffer.from(await res.arrayBuffer());
    if (!image.decryptKey) return enc;
    try {
      const d = createDecipheriv('aes-256-gcm', Buffer.from(image.decryptKey, 'hex'), enc.subarray(0, 12));
      d.setAuthTag(enc.subarray(enc.length - 16));
      return Buffer.concat([d.update(enc.subarray(12, enc.length - 16)), d.final()]);
    } catch (err) {
      throw new TikTokError('DOWNLOAD_FAILED', `Image decryption: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
