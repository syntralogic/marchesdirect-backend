import { findTradeByName, resolveTradeFromText } from '../tradeResolver';

jest.mock('../../config/database', () => ({
  db: {
    query: jest.fn().mockResolvedValue({
      rows: [
        { id: '1', name: 'Isolation', slug: 'isolation', description: 'Isolation thermique et acoustique' },
        { id: '2', name: 'Couverture', slug: 'couverture', description: 'Couverture et étanchéité de toiture' },
        { id: '3', name: 'Peinture', slug: 'peinture', description: 'Peinture et finitions de surface' },
        { id: '4', name: 'Menuiserie', slug: 'menuiserie', description: 'Menuiserie, fenêtres et portes' },
      ],
    }),
  },
}));

// 20 Sep client audit (Marssac): title says isolation thermique extérieure,
// fiche said the métier wasn't specified.
describe('findTradeByName', () => {
  it('matches a long AI phrase to the short canonical trade', async () => {
    expect(await findTradeByName("Isolation thermique par l'extérieur (ITE)")).toEqual({ id: '1', name: 'Isolation' });
  });
  it('matches the other direction and ignores accents/case', async () => {
    expect(await findTradeByName('isolation')).toEqual({ id: '1', name: 'Isolation' });
    expect(await findTradeByName('COUVERTURE - zinguerie')).toEqual({ id: '2', name: 'Couverture' });
  });
  it('returns null for something unrelated', async () => {
    expect(await findTradeByName('Fournitures de bureau')).toBeNull();
    expect(await findTradeByName('')).toBeNull();
  });
});

describe('resolveTradeFromText', () => {
  it('reads the métier off the title', async () => {
    expect(await resolveTradeFromText('Isolation thermique extérieure de la salle des fêtes - Marssac', null))
      .toEqual({ id: '1', name: 'Isolation' });
  });
  it('does not guess when the title has no trade word and the description barely mentions one', async () => {
    expect(await resolveTradeFromText('Travaux divers', 'une porte')).toBeNull();
  });
  it('refuses an ambiguous tie', async () => {
    expect(await resolveTradeFromText('Peinture et couverture', null)).toBeNull();
  });
});
