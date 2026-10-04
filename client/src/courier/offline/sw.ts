import { registerSW } from "virtual:pwa-register";

//the service worker registration. a new build is downloaded in the background and applied on its own, the courier is
//never asked: the plugin stays in prompt mode only so that the reload happens at a quiet moment. a report form that is
//open holds the update (holdUpdate) and the waiting build is applied the moment the last hold is released, so a
//signature half drawn never vanishes under the courier's finger. anywhere else the reload is immediate.
//this module imports virtual:pwa-register, which only exists under the vite plugin: import it from main.tsx and the
//screens only, never from the hooks (vitest aliases it to src/test/pwa-register.stub.ts as a belt and braces)

let updateReady = false;
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
let holds = 0;

//registers the worker. call once from main.tsx, guarded by "serviceWorker" in navigator and import.meta.env.PROD.
//never throws, a failed registration only means no offline shell
export function registerServiceWorker() {
  try {
    updateSW = registerSW({
      onNeedRefresh() {
        updateReady = true;
        applyIfIdle();
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

//keeps a waiting build from reloading the page while the caller is on screen. returns the release function; the
//release is idempotent and applies the update when it was the last hold. a screen calls it in an effect and returns
//the release as the cleanup
export function holdUpdate(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    applyIfIdle();
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//true once a new build is waiting for a quiet moment
export function isUpdateReady() {
  return updateReady;
}

/*──────────────────────────────────────────────────────────────────────────*/

//activates the waiting build and reloads, unless a screen holds the update. the flag is cleared first so a reload
//that takes a moment is not applied twice
function applyIfIdle() {
  if (!updateReady || holds > 0 || !updateSW) return;
  updateReady = false;
  updateSW(true).catch(() => {
    updateReady = true;
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

export function resetSwForTests() {
  updateReady = false;
  updateSW = null;
  holds = 0;
}
