import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDirs, moveSafely, writeSidecar } from './files';

let root: string;
let src: string;
let dest: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'etl-files-'));
  src = path.join(root, 'in');
  dest = path.join(root, 'out');
  await ensureDirs([src, dest]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('moveSafely', () => {
  it('keeps the name when it is free', async () => {
    await fs.writeFile(path.join(src, 'a.xml'), 'one');
    const to = await moveSafely(path.join(src, 'a.xml'), dest, 'a.xml');
    expect(to).toBe(path.join(dest, 'a.xml'));
    expect(await fs.readFile(to, 'utf8')).toBe('one');
    await expect(fs.stat(path.join(src, 'a.xml'))).rejects.toThrow();
  });

  it('falls back to <base>.<n><ext> with the smallest free n and never overwrites', async () => {
    await fs.writeFile(path.join(dest, 'a.xml'), 'kept');
    await fs.writeFile(path.join(dest, 'a.1.xml'), 'kept too');
    await fs.writeFile(path.join(src, 'a.xml'), 'new');
    const to = await moveSafely(path.join(src, 'a.xml'), dest, 'a.xml');
    expect(path.basename(to)).toBe('a.2.xml');
    expect(await fs.readFile(path.join(dest, 'a.xml'), 'utf8')).toBe('kept');
    expect(await fs.readFile(path.join(dest, 'a.1.xml'), 'utf8')).toBe('kept too');
    expect(await fs.readFile(to, 'utf8')).toBe('new');
  });

  it('handles a name with several dots and no extension', async () => {
    await fs.writeFile(path.join(dest, 'a.b.xml'), '');
    await fs.writeFile(path.join(src, 'a.b.xml'), 'x');
    expect(path.basename(await moveSafely(path.join(src, 'a.b.xml'), dest, 'a.b.xml'))).toBe('a.b.1.xml');
    await fs.writeFile(path.join(dest, 'plain'), '');
    await fs.writeFile(path.join(src, 'plain'), 'x');
    expect(path.basename(await moveSafely(path.join(src, 'plain'), dest, 'plain'))).toBe('plain.1');
  });

  it('gives two moves of the same name two names', async () => {
    await fs.writeFile(path.join(src, 'x.xml'), '1');
    await fs.writeFile(path.join(src, 'y.xml'), '2');
    const [a, b] = await Promise.all([moveSafely(path.join(src, 'x.xml'), dest, 'same.xml'), moveSafely(path.join(src, 'y.xml'), dest, 'same.xml')]);
    expect(new Set([path.basename(a), path.basename(b)])).toEqual(new Set(['same.xml', 'same.1.xml']));
  });

  it('releases the reserved name when the source is gone', async () => {
    await expect(moveSafely(path.join(src, 'missing.xml'), dest, 'missing.xml')).rejects.toThrow();
    await expect(fs.stat(path.join(dest, 'missing.xml'))).rejects.toThrow();
  });
});

describe('writeSidecar', () => {
  it('writes <final name>.error.json next to the file', async () => {
    const at = new Date().toISOString();
    const to = await writeSidecar(dest, 'a.1.xml', { file: 'a.xml', sha256: 'abc', error: 'bad', at });
    expect(path.basename(to)).toBe('a.1.xml.error.json');
    expect(JSON.parse(await fs.readFile(to, 'utf8'))).toEqual({ file: 'a.xml', sha256: 'abc', error: 'bad', at });
  });
});
