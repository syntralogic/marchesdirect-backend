// One CSV cell: always quoted, quotes doubled, line breaks flattened, and a
// leading = + - @ (spreadsheet formula injection) neutralised with an apostrophe.
export const csvCell = (v: unknown): string => {
  let t = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
};
