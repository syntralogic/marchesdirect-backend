import { inferNaturePrestation, naturePrestationSql } from '../naturePrestation';

// Ticket R02: "espaces verts" search returned mower spare-parts notices
// alongside the landscaping contracts. These lock in the distinction the
// heuristic has to make, including the cases where it must stay silent.

describe('inferNaturePrestation', () => {
  it('separates a parts purchase from the landscaping work it mentions', () => {
    expect(inferNaturePrestation('Fourniture de pièces détachées pour matériels espaces verts')).toBe('fournitures');
    expect(inferNaturePrestation('Entretien des espaces verts de la commune')).toBe('travaux');
    expect(inferNaturePrestation("Travaux d'aménagement d'espaces verts")).toBe('travaux');
  });

  it('is accent- and case-insensitive', () => {
    expect(inferNaturePrestation('RÉNOVATION DE LA TOITURE DE L’ÉCOLE')).toBe('travaux');
    expect(inferNaturePrestation('renovation de la toiture')).toBe('travaux');
  });

  it("treats supply-plus-installation as 'mixte' rather than forcing a bucket", () => {
    expect(inferNaturePrestation('Fourniture et pose de menuiseries extérieures')).toBe('mixte');
    expect(inferNaturePrestation("Acquisition et installation d'un système de chauffage")).toBe('mixte');
  });

  it('recognises intellectual missions', () => {
    expect(inferNaturePrestation("Mission de maîtrise d'oeuvre pour la réhabilitation du gymnase")).toBe('etudes');
    expect(inferNaturePrestation('Diagnostic amiante avant travaux')).toBe('etudes');
  });

  it('returns null when the wording does not say clearly', () => {
    // The whole point of the conservative design: an unreadable notice must
    // stay unknown so the search keeps showing it, not get guessed into a
    // bucket a filter would then hide it from.
    expect(inferNaturePrestation("Marché de services d'assurance")).toBeNull();
    expect(inferNaturePrestation('Lot 3')).toBeNull();
    expect(inferNaturePrestation('')).toBeNull();
    expect(inferNaturePrestation(null)).toBeNull();
  });

  it('only consults the description when the title is silent', () => {
    expect(inferNaturePrestation('Lot 4', 'Fourniture de consommables informatiques')).toBe('fournitures');
    // Title already decides - a passing mention in the body must not override it.
    expect(inferNaturePrestation('Travaux de voirie', 'fourniture de consommables incluse')).toBe('travaux');
  });
});

describe('naturePrestationSql', () => {
  it('keeps an AI-assigned value ahead of the heuristic', () => {
    expect(naturePrestationSql('o').startsWith('COALESCE(\n    o.nature_prestation,')).toBe(true);
  });

  it('escapes single quotes so the generated SQL cannot break out of a literal', () => {
    const sql = naturePrestationSql('o');
    // Apostrophes inside the French patterns (d'oeuvre, d'ouvrage) must be doubled.
    expect(sql).toContain("d''");
    expect(sql).not.toMatch(/~ '[^']*[^']'[a-z]/);
  });

  it('uses the POSIX word boundary Postgres understands, not \\b', () => {
    const sql = naturePrestationSql('o');
    expect(sql).toContain('\\y');
    expect(sql).not.toContain('\\b');
  });
});
