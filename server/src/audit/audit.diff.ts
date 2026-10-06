//the "what changed" of an edit, for the details of an audit row. the same shape serves an issuance edit (priority, date,
//notes) and a courier update (name, id number, phone...): { field: { from, to } } for the fields that differ, null when
//none does, and null means the service writes no row at all

export type Changes = Record<string, { from: any; to: any }>;

//a plain copy of the fields before the mutation. the services change the entity in place, so the copy is taken first and
//compared after the assignment
export function snapshot(source: Record<string, any>, fields: string[]): Record<string, any> {
  const copy: Record<string, any> = {};
  for (const f of fields) copy[f] = normalize(source?.[f]);
  return copy;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function changesBetween(before: Record<string, any>, after: Record<string, any>, fields: string[]): Changes | null {
  const changes: Changes = {};
  for (const f of fields) {
    const from = normalize(before?.[f]);
    const to = normalize(after?.[f]);
    if (!same(from, to)) changes[f] = { from, to };
  }
  return Object.keys(changes).length ? changes : null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//undefined and null are the same absence. a Date is compared as its utc day, the way new Date('yyyy-mm-dd') reads a
//body value (the date columns themselves come back from postgres as yyyy-mm-dd strings). arrays are copied, so the row
//keeps the values and not a reference to the entity's array
function normalize(v: any): any {
  if (v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(normalize);
  return v;
}

function same(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}
