// Postgres rejects a malformed value for a uuid column with error 22P02
// ("invalid input syntax for type uuid"), which the route handlers' catch
// blocks used to turn into a 500. A garbled or outdated link such as
// /opportunites/123 is a "not found", not a server fault - so route params
// that are uuids are checked up-front with this helper.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);
