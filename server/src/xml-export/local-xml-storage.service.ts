import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

import { xmlExportConfig } from '../env';
import { ObjectMetadata, StorageError, XmlStorage } from './xml-storage';

//the injection token of a fixed directory. nothing registers it: the unit spec hands a temp directory through the
//constructor and the service reads XML_EXPORT_LOCAL_DIR through the env otherwise
export const XML_LOCAL_DIR = 'XML_EXPORT_LOCAL_DIR_FIXED';

//the os codes that mean the directory, not the row: a missing or unreadable root, a root that is a file. the worker
//retries them with the backoff and the log says config, like a bucket that is not there yet
const CONFIG_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);

//a temporary name older than this in the folder of a put was left by a process killed mid write (a put takes
//milliseconds): swept before the put, so a killed worker never leaves partial bytes next to the documents for long
const STALE_TMP_MS = 10 * 60 * 1000;

/*──────────────────────────────────────────────────────────────────────────*/

//the same keys as the bucket, under a directory, for a laptop and the e2e suite. the guarantees of the conditional put
//are kept with what a filesystem has: the body goes to a temporary name in the final folder, is fsync'd, and reaches
//its final name through fs.link, which fails with EEXIST when the name is taken (the create-if-absent; a rename would
//replace). the metadata goes to a sidecar <name>.meta.json the same way, before the xml, so a reader never meets a
//document without its sidecar once the document is there. there is no directory fsync (windows has none): a power
//loss right after the link may lose the name, and the row's next attempt writes it again. development and testing only
@Injectable()
export class LocalXmlStorageService implements XmlStorage {
  constructor(@Optional() @Inject(XML_LOCAL_DIR) private readonly fixedDir?: string) {}

  //write, then link the sidecar, then link the xml. a taken xml name is the precondition category, exactly like a 412.
  //a taken sidecar name is read: with the xml next to it the key is simply taken; without the xml it is an orphan of
  //a crashed attempt, ours when it names this event (the put goes on to the xml), someone else's otherwise
  async putIfAbsent(key: string, body: Buffer, metadata: ObjectMetadata) {
    const dir = this.dir();
    const file = resolveKey(dir, key);
    const sidecar = `${file}.meta.json`;
    const tmp = `${file}.${randomUUID()}.tmp`;
    const metaTmp = `${file}.meta.${randomUUID()}.tmp`;
    try {
      try {
        await mkdir(path.dirname(file), { recursive: true });
      } catch (e) {
        //a day folder, or a parent, that exists as a plain file: the directory is the problem, not the row. mapped here
        //because mkdir says EEXIST for it, which would read as a taken key
        throw new StorageError('transient', `${e?.code || 'error'}: ${path.dirname(file)} cannot be created`, true, e);
      }
      await sweepStaleTemporaries(path.dirname(file));
      //a document already there (an earlier attempt, a file copied in by hand) gets no sidecar of this event: the
      //head must report what is really next to it. the link below catches the one that appears in the meantime
      if (await exists(file)) throw new StorageError('precondition', `EEXIST: ${file} is already there`);
      await writeSynced(tmp, body);
      await writeSynced(metaTmp, Buffer.from(JSON.stringify(metadata), 'utf8'));
      try {
        await link(metaTmp, sidecar);
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        if (await exists(file)) throw new StorageError('precondition', `EEXIST: ${file} is already there`, false, e);
        const orphan = await readSidecar(sidecar);
        //a foreign claim on the key with nothing behind it: no attempt will make it ours, and the worker's head would
        //only see "no object", so the reason is said here and the row is failed for a manager (the key holds the event id,
        //so only a hand made or tampered sidecar gets here)
        if (orphan['event-id'] !== metadata['event-id']) throw new StorageError('permanent', `key_collision: ${sidecar} belongs to event ${orphan['event-id'] || '?'} and no document is next to it`, false, e);
      }
      await link(tmp, file);
    } catch (e) {
      throw categorizeFs(e);
    } finally {
      //the temporary names never outlive the call. a failure here is not the put's failure, so it is swallowed
      await rm(tmp, { force: true }).catch(() => undefined);
      await rm(metaTmp, { force: true }).catch(() => undefined);
    }
  }

  //the sidecar's metadata with content-sha256 recomputed from the bytes on disk: the sidecar is never trusted for the
  //content, and a document copied in by hand has no sidecar, so it reports no event-id and the worker treats it as a
  //collision for a manager. a missing document is null; a root that is missing or a file is a config error (a put
  //would create a missing root, a head reports it: the worker only heads after a put said the key was taken)
  async head(key: string): Promise<{ metadata: Record<string, string> } | null> {
    const dir = this.dir();
    const file = resolveKey(dir, key);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        //windows answers ENOENT, not ENOTDIR, for a path under a file: the root itself is checked before null is given
        const root = await statOrNull(dir).catch((err) => {
          throw categorizeFs(err);
        });
        if (root?.isDirectory()) return null;
        throw new StorageError('transient', `${root ? 'ENOTDIR' : 'ENOENT'}: the export directory ${dir} ${root ? 'is not a directory' : 'does not exist'}`, true, e);
      }
      throw categorizeFs(e);
    }
    let metadata: Record<string, string>;
    try {
      metadata = await readSidecar(`${file}.meta.json`);
    } catch (e) {
      throw categorizeFs(e);
    }
    return { metadata: { ...metadata, 'content-sha256': createHash('sha256').update(bytes).digest('hex') } };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //the directory from the constructor (the specs) or from the env. the service exists in every process, the module
  //registers both backends; a call with the s3 backend configured is a wiring mistake, reported as a config error
  private dir() {
    if (this.fixedDir) return this.fixedDir;
    const dir = xmlExportConfig().localDir;
    if (!dir) throw new StorageError('transient', 'XML_EXPORT_STORAGE is not local, the local storage has no directory', true);
    return dir;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the absolute path of a key, which must stay inside the directory: a key is built by the worker from a checked
//prefix, so anything that resolves elsewhere is a bug or a tampered row, permanent either way and nothing is written
export function resolveKey(dir: string, key: string) {
  if (!key || key.includes('\0') || path.isAbsolute(key)) throw new StorageError('permanent', `key "${key}" is not a relative path`);
  const file = path.resolve(dir, key);
  const inside = path.relative(dir, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new StorageError('permanent', `key "${key}" resolves outside ${dir}`);
  return file;
}

/*──────────────────────────────────────────────────────────────────────────*/

//a new file (wx: the uuid name must not be there), its bytes, and fsync before the link makes it visible under the
//final name, so a document that has a name has its bytes on disk
async function writeSynced(file: string, body: Buffer) {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the string fields of a sidecar; none for a missing or unreadable one (a document without its sidecar is still a document)
async function readSidecar(sidecar: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(sidecar, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the .tmp names of killed processes, older than STALE_TMP_MS, removed from one folder. best effort: a name that is
//gone or cannot be read is somebody else's business, the put itself decides on the key
async function sweepStaleTemporaries(folder: string) {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_MS;
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const full = path.join(folder, name);
    try {
      if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true });
    } catch {
      //gone meanwhile, or not ours to touch
    }
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function exists(p: string) {
  return (await statOrNull(p)) !== null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the os error to the worker's categories: EEXIST is the taken key (a 412), the directory family is transient with the
//config flag (an operator fixes the directory and the rows flow again), everything else transient without it
export function categorizeFs(e: any): StorageError {
  if (e instanceof StorageError) return e;
  const code: string | undefined = e?.code;
  const message = e?.message ? String(e.message) : `${code || e?.name || 'Error'}`;
  if (code === 'EEXIST') return new StorageError('precondition', message, false, e);
  return new StorageError('transient', message, !!code && CONFIG_CODES.has(code), e);
}
