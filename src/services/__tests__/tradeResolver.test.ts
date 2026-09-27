import { findTradeByName, resolveTradeFromText, extractLotTradeSlugs, findTradesBySlugs } from '../tradeResolver';

jest.mock('../../config/database', () => ({
  db: {
    query: jest.fn().mockResolvedValue({
      rows: [
        { id: '1', name: 'Isolation', slug: 'isolation', description: 'Isolation thermique et acoustique' },
        { id: '2', name: 'Couverture', slug: 'couverture', description: 'Couverture et étanchéité de toiture' },
        { id: '3', name: 'Peinture', slug: 'peinture', description: 'Peinture et finitions de surface' },
        { id: '4', name: 'Menuiserie', slug: 'menuiserie', description: 'Menuiserie, fenêtres et portes' },
        { id: '5', name: 'Plâtrerie', slug: 'platrerie', description: 'Plâtrerie et cloisons' },
        { id: '6', name: 'CVC', slug: 'cvc', description: 'Chauffage, ventilation, climatisation' },
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

// 27 Sep client audit, point 4: Le Havre "chauffage urbain" tender, lot 1
// titled "Lot 1 : Plâtrerie – Peinture – Menuiserie bois" surfaced under a
// CVC search because the shared project description (not this lot's own
// object) mentions chauffage urbain.
describe('extractLotTradeSlugs', () => {
  it("reads the lot's own trades off a 'Lot N : ...' title, ignoring anything outside it", () => {
    expect(extractLotTradeSlugs('Lot 1 : Plâtrerie – Peinture – Menuiserie bois')).toEqual(
      expect.arrayContaining(['platrerie', 'peinture', 'menuiserie'])
    );
    expect(extractLotTradeSlugs('Lot 1 : Plâtrerie – Peinture – Menuiserie bois')).not.toContain('cvc');
  });

  it('handles a plain hyphen and a lot number with letters', () => {
    expect(extractLotTradeSlugs('Lot 2A - Couverture zinguerie')).toEqual(['couverture']);
  });

  it('returns [] for a title that is not shaped like a lot ("Lot N : ...")', () => {
    expect(extractLotTradeSlugs('Exploitation et maintenance des installations CVC - Épernay')).toEqual([]);
    expect(extractLotTradeSlugs(null)).toEqual([]);
  });

  it('returns [] when the lot names nothing recognisable', () => {
    expect(extractLotTradeSlugs('Lot 3 : Divers')).toEqual([]);
  });
});

describe('findTradesBySlugs', () => {
  it('resolves slugs back to their canonical trade rows', async () => {
    const trades = await findTradesBySlugs(['platrerie', 'peinture']);
    expect(trades.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: '3', name: 'Peinture' },
      { id: '5', name: 'Plâtrerie' },
    ]);
  });

  it('returns [] for an empty input without querying', async () => {
    expect(await findTradesBySlugs([])).toEqual([]);
  });
});
