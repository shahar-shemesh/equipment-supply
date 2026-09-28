import "fake-indexeddb/auto";

//vitest setup: an in memory indexeddb on the global, and node's webcrypto for uuid.ts when the jsdom window has none.
//the module name is built at runtime so tsc (no @types/node in the client) does not look for it
if (!globalThis.crypto?.getRandomValues) {
  const nodeCrypto: any = await import("node:" + "crypto");
  (globalThis as any).crypto = nodeCrypto.webcrypto;
}
