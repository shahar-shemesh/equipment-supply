import * as fs from 'fs/promises';
import * as path from 'path';

//the file lifecycle after the database said its word: a move that keeps the name and never overwrites, and the
//sidecar next to a refused file. no file is ever deleted by this service

//the fallback on a taken name: <base>.<n><ext> with the smallest free n from 1. the name is reserved exclusively
//(open with wx) before the rename, so two processes archiving the same name at the same moment get two names. on
//EXDEV (the archive is another volume) the bytes are copied into the reserved placeholder, which is ours, and the
//source is unlinked afterwards
export async function moveSafely(src: string, destDir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 10000; n++) {
    const candidate = n === 0 ? name : `${base}.${n}${ext}`;
    const dest = path.join(destDir, candidate);
    try {
      const handle = await fs.open(dest, 'wx');
      await handle.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    try {
      await fs.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
        await fs.unlink(dest).catch(() => undefined);
        throw e;
      }
      try {
        await fs.copyFile(src, dest);
      } catch (copyError) {
        //a half copied file under the final name would pass for the document; the placeholder goes, the source stays
        await fs.unlink(dest).catch(() => undefined);
        throw copyError;
      }
      await fs.unlink(src);
    }
    return dest;
  }
  throw new Error(`no free name for ${name} in ${destDir}`);
}

export type Sidecar = { file: string; sha256: string; error: string; at: string };

//<final name>.error.json next to the refused file, so the pair stays together under a fallback name too
export async function writeSidecar(destDir: string, finalName: string, body: Sidecar): Promise<string> {
  const dest = path.join(destDir, `${finalName}.error.json`);
  await fs.writeFile(dest, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return dest;
}

export async function ensureDirs(dirs: string[]) {
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });
}
