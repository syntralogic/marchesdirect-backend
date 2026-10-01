// ============================================================================
// BOAMP LOTS -> SEARCHABLE TEXT
//
// 30 Sep client report (comparatif moteur): consultations whose électricité is
// only a LOT of a bigger works contract (Bordeaux micro-tomographe 26-93928,
// Châlons 26-94389, Sainte-Hélène 26-89823, Bretenière 26-93682...) were
// imported but never found by "électricité": the search vector is built from
// title + description only, and for BOAMP the description was just `objet`
// (the global title). The lots live in BOAMP's `donnees` JSON (legacy
// "LOTS"/"LOT" blocks, eForms "ProcurementProjectLot"), which was stored in
// raw_data but never read.
//
// extractBoampLotsText() walks `donnees` generically (the shape differs by
// notice form and I could not inspect live records from the build sandbox) and
// keeps the human-readable strings found under any key whose name mentions a
// lot. The result is appended to the description, which feeds search_vector
// (title 'A' / description 'B'), so a lot is searchable without touching the
// schema. Nothing is invented: only strings present in the source are used.
// ============================================================================

const MAX_LOTS_CHARS = 3000;
const MAX_DEPTH = 12;

const looksLikeNoise = (s: string): boolean => {
  const t = s.trim();
  if (t.length < 4) return true;
  if (/^[\d\s.,:/\-+€%]+$/.test(t)) return true;            // numbers, dates, amounts
  if (/^(https?:\/\/|www\.)/i.test(t)) return true;         // urls
  if (/^[A-Z]{2,3}$/.test(t)) return true;                  // codes (FRA, EUR)
  if (/^(true|false|oui|non)$/i.test(t)) return true;
  return false;
};

const LOT_KEY_RE = /lot/i;

function collect(node: any, underLot: boolean, depth: number, out: string[]): void {
  if (node == null || depth > MAX_DEPTH) return;
  if (typeof node === 'string') {
    if (underLot && !looksLikeNoise(node)) out.push(node.replace(/\s+/g, ' ').trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collect(v, underLot, depth + 1, out);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // Skip pure metadata keys even inside a lot (ids, codes, urls).
      if (underLot && /^(@|(.*:)?id$|.*(url|uri|code|date|montant|valeur|nuts|cpv|currency|devise|langue|language)$)/i.test(k)) continue;
      collect(v, underLot || LOT_KEY_RE.test(k), depth + 1, out);
    }
  }
}

export function extractBoampLotsText(donnees: unknown): string {
  if (donnees == null || donnees === '') return '';
  let parsed: any = donnees;
  if (typeof donnees === 'string') {
    try { parsed = JSON.parse(donnees); } catch { return ''; }
  }
  const strings: string[] = [];
  collect(parsed, false, 0, strings);
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const s of strings) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  let text = uniq.join(' ; ');
  if (text.length > MAX_LOTS_CHARS) text = text.slice(0, MAX_LOTS_CHARS).replace(/\s+\S*$/, '');
  return text;
}

/** Appends the lots text to a description once, never duplicating text the description already holds. */
export function withLotsText(description: string, lotsText: string): string {
  const base = (description || '').trim();
  const lots = (lotsText || '').trim();
  if (!lots) return base;
  if (base.toLowerCase().includes(lots.slice(0, 80).toLowerCase())) return base;
  return base ? `${base}\n\nLots : ${lots}` : `Lots : ${lots}`;
}

/**
 * The individual lots appended by withLotsText() ("Lots : a ; b ; c"), so the
 * concordance can read each lot on its own instead of only the global title.
 */
export function lotsFromDescription(description: string | null | undefined): string[] {
  const m = /(?:^|\n)\s*Lots\s*:\s*([\s\S]+)$/.exec(String(description || ''));
  if (!m) return [];
  return m[1].split(/\s;\s/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 4);
}
