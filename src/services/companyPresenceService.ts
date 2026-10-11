import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';

// Client item 4 (Facebook page + Google reviews in the company info).
// Pappers/INSEE have neither, so they are looked up separately:
//  - Google rating + review count: Google Places API (New) "searchText",
//    matched on the company's postal code so a namesake in another town is
//    never shown as this company's rating.
//  - Facebook page: the facebook.com link found on the company's own website
//    (a link the company itself published), with Places' website as a second
//    source. Nothing is guessed from the name.
// Anything not found stays null - never fabricated. Needs
// GOOGLE_PLACES_API_KEY; without it this is a no-op.

export interface CompanyPresence {
  facebook: string | null; // full https URL of the page
  googleRating: string | null;
  googleReviewCount: number | null;
  website: string | null;
}

interface PresenceInput {
  name: string | null;
  city: string | null;
  postal: string | null;
  address: string | null;
  website: string | null;
}

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FB_HOST = /^(?:[a-z0-9-]+\.)?(?:facebook|fb)\.com$/i;
// Share/plugin/login URLs are not the company's own page.
const FB_NOT_A_PAGE = /^\/(?:sharer|share|plugins|dialog|login|tr|policy|help|privacy|groups|events|hashtag|watch|marketplace|reel|photo|story\.php|permalink\.php)(?:[/.?]|$)/i;

export function isPresenceConfigured(): boolean {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY);
}

export function normalizeFacebookUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`);
    if (!FB_HOST.test(u.hostname)) return null;
    if (u.pathname === '/' || FB_NOT_A_PAGE.test(u.pathname)) return null;
    // profile.php?id=123 is a valid page URL; keep only the id then.
    if (/^\/profile\.php/i.test(u.pathname)) {
      const id = u.searchParams.get('id');
      return id ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}` : null;
    }
    // /share/<token>/ links are public share links of a page: keep as given.
    return `https://www.facebook.com${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

async function findFacebookOnWebsite(websiteUrl: string): Promise<string | null> {
  try {
    const { data } = await axios.get<string>(websiteUrl, {
      timeout: 5000,
      maxRedirects: 3,
      maxContentLength: 2 * 1024 * 1024,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarchesDirectBot/1.0)', Accept: 'text/html' },
      validateStatus: s => s >= 200 && s < 400,
    });
    const $ = cheerio.load(String(data));
    const hrefs: string[] = [];
    $('a[href]').each((_, el) => { hrefs.push($(el).attr('href') || ''); });
    $('meta[property="og:see_also"], link[rel="me"]').each((_, el) => {
      hrefs.push($(el).attr('content') || $(el).attr('href') || '');
    });
    for (const h of hrefs) {
      const fb = normalizeFacebookUrl(h);
      if (fb) return fb;
    }
  } catch (err: any) {
    logger.info(`Presence: website fetch failed for ${websiteUrl}: ${err.code || err.message}`);
  }
  return null;
}

async function findGooglePlace(input: PresenceInput): Promise<{ rating: number | null; count: number | null; website: string | null } | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key || !input.name) return null;
  const textQuery = [input.name, input.address, input.postal, input.city].filter(Boolean).join(' ');
  try {
    const { data } = await axios.post(
      PLACES_URL,
      { textQuery, languageCode: 'fr', regionCode: 'FR', maxResultCount: 5 },
      {
        timeout: 6000,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri',
        },
      }
    );
    const places: any[] = Array.isArray(data?.places) ? data.places : [];
    const postal = (input.postal || '').trim();
    const nameTokens = input.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(t => t.length > 2);
    const match = places.find(p => {
      const addr = String(p.formattedAddress || '');
      const sameTown = postal ? addr.includes(postal) : (input.city ? addr.toLowerCase().includes(input.city.toLowerCase()) : false);
      if (!sameTown) return false;
      const shown = String(p.displayName?.text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return nameTokens.length === 0 || nameTokens.some(t => shown.includes(t));
    });
    if (!match) return null;
    return {
      rating: typeof match.rating === 'number' ? match.rating : null,
      count: typeof match.userRatingCount === 'number' ? match.userRatingCount : null,
      website: normalizeWebsite(match.websiteUri),
    };
  } catch (err: any) {
    logger.error('Presence: Google Places lookup failed:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

export async function lookupCompanyPresence(input: PresenceInput): Promise<CompanyPresence> {
  const out: CompanyPresence = { facebook: null, googleRating: null, googleReviewCount: null, website: null };
  if (!isPresenceConfigured()) return out;

  const place = await findGooglePlace(input);
  if (place) {
    if (place.rating != null && place.count) {
      out.googleRating = place.rating.toFixed(1);
      out.googleReviewCount = place.count;
    }
    out.website = place.website;
  }

  const sites = [normalizeWebsite(input.website), place?.website || null].filter((s, i, a): s is string => !!s && a.indexOf(s) === i);
  for (const site of sites) {
    // The company's own site may itself be its Facebook page.
    const direct = normalizeFacebookUrl(site);
    if (direct) { out.facebook = direct; break; }
    const fb = await findFacebookOnWebsite(site);
    if (fb) { out.facebook = fb; break; }
  }
  return out;
}
