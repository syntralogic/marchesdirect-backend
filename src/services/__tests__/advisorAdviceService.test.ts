jest.mock('../../config/database', () => ({ db: { query: jest.fn() } }));
jest.mock('../aiService', () => ({ generateAdvisorText: jest.fn() }));
jest.mock('../matchScoreService', () => ({ computeMatchScore: jest.fn() }));
import { isAcceptableAdvice, OPPORTUNITY_PROMPT, COMPATIBILITY_PROMPT } from '../advisorAdviceService';

const good = 'Votre activité de peintre correspond aux travaux recherchés : regardons cette piste ! Vous pouvez préciser votre expérience et votre organisation avec les quatre questions. Nous vous aidons ensuite à préparer la suite.';

describe('isAcceptableAdvice', () => {
  it('accepts a brief-conforming text', () => expect(isAcceptableAdvice('compatibility', good)).toBe(true));
  it('rejects too short / too long', () => {
    expect(isAcceptableAdvice('opportunity', 'Trop court.')).toBe(false);
    expect(isAcceptableAdvice('opportunity', 'mot '.repeat(120))).toBe(false);
  });
  it('rejects win-probability and guarantee wording', () => {
    expect(isAcceptableAdvice('opportunity', good + ' Vous avez de bonnes chances de gagner ce marché.')).toBe(false);
  });
  it('rejects a recited score in compatibility only', () => {
    expect(isAcceptableAdvice('compatibility', good + ' Indice 72 %.')).toBe(false);
    expect(isAcceptableAdvice('opportunity', good + ' Indice 72 %.')).toBe(true);
  });
});

describe('prompts', () => {
  it('keep the key rules of the brief', () => {
    expect(OPPORTUNITY_PROMPT).toMatch(/entre 40 et 65 mots/);
    expect(OPPORTUNITY_PROMPT).toMatch(/ne lui attribue aucune expérience/);
    expect(COMPATIBILITY_PROMPT).toMatch(/Ne récite pas le score/);
    expect(COMPATIBILITY_PROMPT).toMatch(/Une information inconnue n'est pas un défaut/);
  });
});
