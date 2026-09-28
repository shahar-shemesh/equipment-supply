import { registerSW } from "virtual:pwa-register";

//the service worker registration, prompt mode: a new build is downloaded and waits until the courier taps עדכון. never
//an automatic reload, a signature half drawn must not vanish under the courier's finger.
//this module imports virtual:pwa-register, which only exists under the vite plugin: import it from main.tsx and the
//status bar only, never from the hooks (vitest aliases it to src/test/pwa-register.stub.ts as a belt and braces)

let updateReady = false;
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<(ready: boolean) => void>();

//registers the worker. call once from main.tsx, guarded by "serviceWorker" in navigator and import.meta.env.PROD.
//never throws, a failed registration only means no offline shell
export function registerServiceWorker() {
  try {
    updateSW = registerSW({
      onNeedRefresh() {
        updateReady = true;
        for (const fn of Array.from(listeners)) fn(true);
      },
      onRegisterError(e) {
        // console.log("service worker registration failed", e);
      },
    });
  } catch (e) {
    // console.log("service worker registration failed", e);
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//true once a new build is waiting
export function isUpdateReady() {
  return updateReady;
}

/*──────────────────────────────────────────────────────────────────────────*/

//called with true when a new build is waiting. returns the unsubscribe function
export function subscribeSw(fn: (ready: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//activates the waiting build and reloads. only ever called from the עדכון button
export async function applyUpdate() {
  if (!updateSW) return;
  updateReady = false;
  await updateSW(true);
}
