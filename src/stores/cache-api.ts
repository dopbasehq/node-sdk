import type { CacheStore } from './types';

// Cache API keys must be URLs. This host never resolves; it only names entries.
const ORIGIN = 'https://dopbase-sdk.cache';

/**
 * The Web Cache API (`caches`), on Cloudflare Workers, Deno and Netlify Edge.
 * On Workers it is shared by every isolate in a data center, so a cold
 * isolate can skip the network.
 */
export class CacheApiStore implements CacheStore {
  readonly #maxAgeSeconds: number;
  readonly #name: string;
  #cache: Promise<Cache> | undefined;

  constructor(options: { maxAgeSeconds: number; name?: string }) {
    this.#maxAgeSeconds = Math.max(1, Math.floor(options.maxAgeSeconds));
    this.#name = options.name ?? 'dopbase';
  }

  static available(): boolean {
    return typeof globalThis.caches?.open === 'function';
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await (await this.#open()).match(`${ORIGIN}/${key}`);
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const response = new Response(value as BodyInit, {
      headers: {
        'Cache-Control': `max-age=${this.#maxAgeSeconds}`,
        'Content-Type': 'application/octet-stream',
      },
    });
    await (await this.#open()).put(`${ORIGIN}/${key}`, response);
  }

  #open(): Promise<Cache> {
    this.#cache ??= globalThis.caches.open(this.#name);
    return this.#cache;
  }
}
