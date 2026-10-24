declare module 'js-yaml' {
  export function load(source: string, options?: { maxAliasCount?: number }): unknown;
  export function loadAll(source: string, options?: { maxAliasCount?: number }): unknown[];
}
