import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareNames, countCandidates, isCandidateName, scan } from './scanner';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'etl-scan-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function touch(name: string, content = '<x/>', ageMs = 60000) {
  const full = path.join(dir, name);
  await fs.writeFile(full, content);
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(full, when, when);
  return full;
}

describe('scan', () => {
  it('lists regular .xml files only, case blind, sorted by name, with their size', async () => {
    await touch('b.xml', '<b/>');
    await touch('A.XML', '<aaa/>');
    await touch('notes.txt');
    await touch('.hidden.xml');
    await touch('x.xml.tmp');
    await touch('y.XML.part');
    await touch('z.xml~');
    await fs.mkdir(path.join(dir, 'dir.xml'));
    const result = await scan({ dir, minAgeMs: 2000, batchSize: 100 });
    expect(result.files).toEqual([
      { name: 'A.XML', path: path.join(dir, 'A.XML'), size: 6 },
      { name: 'b.xml', path: path.join(dir, 'b.xml'), size: 4 },
    ]);
    expect(result.ignored).toBe(6);
    expect(result.young).toBe(0);
    expect(result.missingDir).toBe(false);
  });

  it('leaves a young file for the next run and cuts the list to the batch', async () => {
    await touch('1.xml', '<a/>', 500);
    await touch('2.xml');
    await touch('3.xml');
    await touch('4.xml');
    const result = await scan({ dir, minAgeMs: 2000, batchSize: 2 });
    expect(result.files.map((f) => f.name)).toEqual(['2.xml', '3.xml']);
    expect(result.young).toBe(1);
    const later = await scan({ dir, minAgeMs: 2000, batchSize: 10, now: () => Date.now() + 5000 });
    expect(later.files.map((f) => f.name)).toEqual(['1.xml', '2.xml', '3.xml', '4.xml']);
  });

  it('does not hold a file whose mtime is ahead of the clock', async () => {
    await touch('ahead.xml', '<a/>', -60000);
    const result = await scan({ dir, minAgeMs: 2000, batchSize: 10 });
    expect(result.files.map((f) => f.name)).toEqual(['ahead.xml']);
    expect(result.young).toBe(0);
  });

  it('answers a missing directory with an empty run and the flag', async () => {
    const result = await scan({ dir: path.join(dir, 'nope'), minAgeMs: 0, batchSize: 10 });
    expect(result).toEqual({ files: [], young: 0, ignored: 0, missingDir: true, unreadable: [] });
    expect(await countCandidates(path.join(dir, 'nope'))).toBe(0);
  });

  it('counts the candidate names for the status without stat', async () => {
    await touch('a.xml');
    await touch('b.xml', '<b/>', 0);
    await touch('c.txt');
    expect(await countCandidates(dir)).toBe(2);
  });
});

describe('names', () => {
  it('filters the names the plan lists', () => {
    expect(['a.xml', 'A.XML', 'a.b.xml'].every(isCandidateName)).toBe(true);
    expect(['.a.xml', 'a.tmp', 'a.xml.tmp', 'a.XML.part', 'a.xml~', 'a.txt', 'a.xmlx', 'xml'].some(isCandidateName)).toBe(false);
  });

  it('sorts by codepoint, so a supplementary character sorts after the basic plane', () => {
    expect(['b', 'a', '\u{1F600}', '�', 'ab'].sort(compareNames)).toEqual(['a', 'ab', 'b', '�', '\u{1F600}']);
    expect(compareNames('a', 'a')).toBe(0);
  });
});
