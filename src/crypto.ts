// Web Crypto only, so the same code runs on Node, Bun, Deno and edge runtimes.

const encoder = new TextEncoder();
const SALT = encoder.encode('dopbase-sdk-cache-v1');
const AAD = encoder.encode('dopbase-sdk-record-v1');
const IV_BYTES = 12;

export interface CacheKeys {
  /** The store key: a hash, so it reveals neither the token nor the host. */
  id: string;
  key: CryptoKey;
}

/** One AES-256-GCM key per (host, token), derived with HKDF from the token. */
export async function deriveCacheKeys(baseUrl: string, token: string): Promise<CacheKeys> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`dopbase-sdk-cache-id\0${baseUrl}\0${token}`),
  );
  const id = [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const material = await crypto.subtle.importKey('raw', encoder.encode(token), 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: encoder.encode(baseUrl) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { id, key };
}

/** IV followed by ciphertext. */
export async function seal(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    key,
    plaintext as BufferSource,
  );
  const blob = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(ciphertext), IV_BYTES);
  return blob;
}

/** Throws if the blob was changed, or was sealed with another token. */
export async function open(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.slice(0, IV_BYTES), additionalData: AAD },
    key,
    blob.slice(IV_BYTES),
  );
  return new Uint8Array(plaintext);
}
