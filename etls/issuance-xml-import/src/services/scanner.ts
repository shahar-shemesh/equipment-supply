import * as fs from 'fs/promises';
import * as path from 'path';

//discovery in the input directory: regular files ending .xml (case blind), nothing that starts with a dot or ends
//.tmp / .part / ~ (an editor's or an sftp client's file in the making), nothing modified in the last minAgeMs (still
//being written), sorted by name in codepoint order and cut to the batch. the size comes from stat and goes with the
//candidate: the pipeline re-checks it before the read and refuses an oversized file without reading it

export type Candidate = { name: string; path: string; size: number };
export type ScanOptions = { dir: string; minAgeMs: number; batchSize: number; now?: () => number };
export type ScanResult = { files: Candidate[]; young: number; ignored: number; missingDir: boolean; unreadable: { name: string; code: string }[] };

/*──────────────────────────────────────────────────────────────────────────*/

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  let names: string[];
  try {
    names = await fs.readdir(opts.dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], young: 0, ignored: 0, missingDir: true, unreadable: [] };
    throw e;
  }

  const result: ScanResult = { files: [], young: 0, ignored: 0, missingDir: false, unreadable: [] };
  const eligible: Candidate[] = [];
  for (const name of names.sort(compareNames)) {
    if (!isCandidateName(name)) {
      result.ignored++;
      continue;
    }
    const full = path.join(opts.dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch (e) {
      //gone between readdir and stat is somebody else's business; anything else (a permission the dropper set wrong)
      //is named, so the run can log it instead of a file that silently never imports
      const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (code !== 'ENOENT') result.unreadable.push({ name, code });
      continue;
    }
    if (!stat.isFile()) {
      result.ignored++;
      continue;
    }
    //zero turns the check off. an mtime ahead of the clock (a writer's clock that runs ahead, an sftp client that keeps
    //the source's time, ntfs rounding its own way) is not young either: the file would otherwise wait until the
    //local clock passes its mtime, and the size re-check in the pipeline still catches a file that is growing
    const age = now() - stat.mtimeMs;
    if (opts.minAgeMs > 0 && age >= 0 && age < opts.minAgeMs) {
      result.young++;
      continue;
    }
    eligible.push({ name, path: full, size: stat.size });
  }
  result.files = eligible.slice(0, opts.batchSize);
  return result;
}

//the names only, no stat: what GET /status reports as awaiting
export async function countCandidates(dir: string): Promise<number> {
  try {
    return (await fs.readdir(dir)).filter(isCandidateName).length;
  } catch {
    return 0;
  }
}

export function isCandidateName(name: string) {
  if (name.startsWith('.')) return false;
  if (!/\.xml$/i.test(name)) return false;
  return !/(\.tmp|\.part|~)$/i.test(name);
}

//codepoint order, not utf-16 code unit order: the two differ only above the basic plane, but "sorted by name" should
//mean one thing on every machine
export function compareNames(a: string, b: string) {
  const ca = Array.from(a, (ch) => ch.codePointAt(0)!);
  const cb = Array.from(b, (ch) => ch.codePointAt(0)!);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  return ca.length - cb.length;
}
