import { extractCandidateDocumentUrls } from '../documentIngestionService';

describe('extractCandidateDocumentUrls', () => {
  it('finds URL-like strings anywhere in a nested raw record', () => {
    const raw = {
      fields: {
        objet: 'Travaux de voirie',
        url_avis: 'https://boamp.fr/avis/12345',
      },
      pieces_jointes: [
        { nom: 'CCAP', lien: 'https://buyer-portal.fr/dce/ccap.pdf' },
        { nom: 'RC', lien: 'https://buyer-portal.fr/dce/reglement-consultation.pdf' },
      ],
    };

    const candidates = extractCandidateDocumentUrls(raw);
    const urls = candidates.map((c) => c.url);

    expect(urls).toContain('https://boamp.fr/avis/12345');
    expect(urls).toContain('https://buyer-portal.fr/dce/ccap.pdf');
    expect(urls).toContain('https://buyer-portal.fr/dce/reglement-consultation.pdf');
  });

  it('guesses labels from key names and URL content', () => {
    const raw = { ccap_url: 'https://example.fr/doc/xyz.pdf' };
    const candidates = extractCandidateDocumentUrls(raw);
    expect(candidates[0].labelHint).toBe('CCAP');
  });

  it('returns an empty array when there is nothing URL-shaped', () => {
    const raw = { fields: { objet: 'Travaux de voirie', montant: 15000 } };
    expect(extractCandidateDocumentUrls(raw)).toEqual([]);
  });

  it('deduplicates repeated URLs and caps the result size', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      many[`doc_${i}`] = `https://example.fr/dce/file-${i}.pdf`;
    }
    const candidates = extractCandidateDocumentUrls(many);
    expect(candidates.length).toBeLessThanOrEqual(8);
  });

  it('ignores non-URL strings', () => {
    const raw = { titulaire: 'ACME BTP', reference: 'AO-2026-042' };
    expect(extractCandidateDocumentUrls(raw)).toEqual([]);
  });
});
