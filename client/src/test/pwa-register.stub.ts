//stands in for virtual:pwa-register under vitest (vitest.config.ts alias). no worker, no update
export function registerSW(_options?: any) {
  return async (_reload?: boolean) => {};
}
