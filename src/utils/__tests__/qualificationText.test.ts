import { extractQualificationsFromText } from '../qualificationText';

describe('extractQualificationsFromText (30 Sep audit: IRVE required, concordance said none)', () => {
  it('reads the IRVE / Qualifelec requirement from the notice text', () => {
    const t = "Déploiement de bornes de recharge à Dijon. Le sous-traitant doit justifier d'une qualification IRVE (Qualifelec ou équivalent). Démarrage en novembre.";
    expect(extractQualificationsFromText(t)).toMatch(/IRVE \(Qualifelec ou équivalent\)/);
  });
  it('returns null when the text names no recognised qualification', () => {
    expect(extractQualificationsFromText('Nettoyage des locaux de la mairie, deux passages par semaine.')).toBeNull();
    expect(extractQualificationsFromText(null, undefined, '')).toBeNull();
  });
  it('does not treat a mere mention without a requirement as a requirement', () => {
    expect(extractQualificationsFromText('Les bornes IRVE sont installées sur le parking nord.')).toBeNull();
  });
});
