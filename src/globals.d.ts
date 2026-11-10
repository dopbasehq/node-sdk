/** Replaced with the package version at build time. */
declare const __VERSION__: string;

declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}
