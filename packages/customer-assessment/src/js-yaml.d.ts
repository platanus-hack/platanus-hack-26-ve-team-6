declare module 'js-yaml' {
  export function loadAll(source: string, options?: { maxAliasCount?: number }): unknown[];
}
