const clean = (v: unknown) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';

// Presentation only: retain raw attribution and original titles in storage.
export function visitSource(source: unknown, campaign: unknown): string {
 const readable = clean(campaign).replace(/_/g, ' ').replace(/^recette\s+/i, '').replace(/\belectriciens\b/gi, 'électriciens');
 return [clean(source).replace(/^sms$/i, 'SMS'), readable].filter(Boolean).join(' ');
}

export function shortOfferTitle(value: string): string {
 let title = clean(value).replace(/…|\.{3}/g, '')
  .replace(/^L['’]accord-cadre a pour objet l['’]acquisition de fourniture de\s+/i, 'Fourniture de ');
 // A named venue is more useful on a phone than a long procurement preamble.
 const venue = title.match(/\bMusée\s+[^,;.]+/i);
 if (venue) title = venue[0].replace(/Jacquemart\s+André/i, 'Jacquemart-André');
 const words = title.split(/\s+/).slice(0, 6);
 while (words.length > 1 && /^(de|du|des|d['’]|le|la|les|un|une|au|aux|et|à|en|par|pour|sur|–|—|-)$/i.test(words[words.length - 1])) words.pop();
 return words.join(' ');
}

export function visitAction(choice: any): string {
 switch (choice?.event_type) {
  case 'callback_requested': {
   const preference = typeof choice.request_message === 'string'
    ? choice.request_message.match(/(?:^|\n)Créneau souhaité\s*:\s*([^\n]+)/i)?.[1] : undefined;
   return `À faire : rappeler · préférence : ${clean(preference).slice(0, 100) || 'non précisée'}`;
  }
  case 'dossier_requested': return 'À faire : envoyer le dossier';
  case 'appointment_booked': {
   const date = choice.request_slot_at && new Date(choice.request_slot_at);
   return date && Number.isFinite(date.getTime())
    ? `À faire : rendez-vous le ${date.toLocaleDateString('fr-FR', {timeZone:'Europe/Paris'})} à ${date.toLocaleTimeString('fr-FR', {timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit'}).replace(':','h')} (heure de Paris)`
    : 'À faire : confirmer la date du rendez-vous';
  }
  case 'demande_info': return 'À faire : répondre à la demande de renseignement';
  default: return 'À faire : préciser le besoin';
 }
}
