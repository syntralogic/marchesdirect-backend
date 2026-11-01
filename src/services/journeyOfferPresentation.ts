// Keep links and public references aligned with the existing opportunity page.
export function offerUrl(id: unknown): string | undefined {
  return typeof id === 'string' && id.trim()
    ? `https://marchesdirect.fr/opportunites/${encodeURIComponent(id.trim())}`
    : undefined;
}

const text = (value: unknown) => typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
const parisDate = (date: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

export function describeOffer(offer: any, now: Date): string {
  const id = offer.offer_id || offer.opportunity_id;
  const title = text(offer.offer_title || offer.title) || 'Annonce';
  const department = text(offer.location_department);
  const reference = text(offer.source_reference);
  const publicReference = reference && !/^(editorial-|demo-)/i.test(reference)
    ? reference : id ? `MD-${String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()}` : '';
  let deadline = 'Échéance non renseignée';
  if (offer.deadline) {
    const date = new Date(offer.deadline);
    if (Number.isFinite(date.getTime())) {
      const days = Math.round((Date.parse(parisDate(date)) - Date.parse(parisDate(now))) / 86400000);
      const calendarDate = date.toLocaleDateString('fr-FR', {timeZone: 'Europe/Paris'});
      deadline = `${days >= 0 ? `J-${days}` : `Échue depuis ${-days} j`} (${calendarDate})`;
    }
  }
  return [
    `${title} (${department || 'département non renseigné'})`,
    publicReference ? `réf. ${publicReference}` : 'Référence non renseignée',
    deadline, offerUrl(id),
  ].filter(Boolean).join(' · ');
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// Presentation only: two sessions may select the same company seconds apart.
// Keep all raw events and their timestamps for activity/abandonment and notes.
export function distinctTimelineEvents(events: any[]): any[] {
  const lastDisplayed = new Map<string, number>();
  return events.filter(event => {
    const key = JSON.stringify([event.event_type, event.offer_id || null, canonical(event.event_data || {})]);
    const at = new Date(event.at).getTime();
    const previous = lastDisplayed.get(key);
    if (previous !== undefined && at >= previous && at - previous < 60000) return false;
    lastDisplayed.set(key, at);
    return true;
  });
}
