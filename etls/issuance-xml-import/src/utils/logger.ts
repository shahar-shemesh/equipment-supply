import type { LogLevel } from '../config/env';

//one json object per line on stdout, { ts, level, msg, ...fields }, so a log shipper needs no parser of its own. the
//fields are ids and counts: run_id, file, sha256 (the first 12 hex chars), document_id, sap_number, issuance_id,
//instance_id. never the xml, never a customer field, never the password: the callers are written that way and the
//logger adds nothing of its own. child() binds fields for the rest of a run or a file

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/*──────────────────────────────────────────────────────────────────────────*/

export function createLogger(level: LogLevel, bound: Fields = {}, write: (line: string) => void = defaultWrite): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Fields) => {
    if (RANK[lvl] < RANK[level]) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...bound, ...fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(level, { ...bound, ...fields }, write),
  };
}

//the log field of a sha256: enough to find the row, short enough for a line
export function shortSha(sha256: string) {
  return sha256.slice(0, 12);
}

function defaultWrite(line: string) {
  process.stdout.write(line + '\n');
}
