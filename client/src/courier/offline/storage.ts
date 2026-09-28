import { writeTx } from "./db";
import { metaFromScope } from "./store";

let asked: Promise<boolean | null> | null = null;

//asks the browser not to evict this origin's storage. it is a request, not a guarantee: "clear site data", a manual
//"clear browsing data" or an eviction the browser decides on anyway still delete everything, and browsers without the
//api (or on plain http) answer null. asked once per session, the answer lands in meta.persistent for the pending dialog.
//returns true / false / null (unsupported), never throws
export function requestPersistentStorage(scope: string): Promise<boolean | null> {
  if (!asked) asked = ask();
  return asked.then(async (persistent) => {
    if (!scope) return persistent;
    try {
      await writeTx(["meta"], async (tx) => {
        const meta = (await tx.objectStore("meta").get(scope)) || metaFromScope(scope);
        await tx.objectStore("meta").put({ ...meta, persistent });
      });
    } catch (e) {
      //a failed meta write is not worth a message, the dialog just shows nothing about persistence
    }
    return persistent;
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

async function ask(): Promise<boolean | null> {
  const storage: any = typeof navigator !== "undefined" ? navigator.storage : null;
  if (!storage?.persist) return null;
  try {
    return !!(await storage.persist());
  } catch (e) {
    return null;
  }
}
