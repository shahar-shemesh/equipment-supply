import * as fs from 'fs';
import * as path from 'path';

//the package root: the first directory above this file that holds a package.json. from the sources that is
//etls/issuance-xml-import; from the build (dist/etls/issuance-xml-import/src/config) the walk passes dist, which holds
//no package.json, and lands on the same directory. never process.cwd(): a service started from another directory
//(a systemd unit, a container entrypoint) still finds its data folders and its .env
export const PROJECT_ROOT = findRoot(__dirname);

export function resolveFromRoot(p: string) {
  return path.resolve(PROJECT_ROOT, p);
}

/*──────────────────────────────────────────────────────────────────────────*/

function findRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json found above ${from}`);
    dir = parent;
  }
}
