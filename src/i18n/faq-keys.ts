/**
 * Single source of truth for the FAQ list. Used by FAQ.astro to render
 * and by Base.astro to emit the FAQPage JSON-LD schema. Order = reading
 * flow on the page.
 */
export const FAQ_KEYS = [
  'compatible_plc',
  'data_format',
  'powerbi',
  'self_host',
  'minimum_hardware',
  'security',
  'safety_sil',
  'company_disappears',
  'multi_site',
  'wiresheet_status',
  'support',
  'trial',
  'trial_what_happens',
  'trial_end',
] as const;

export type FAQKey = (typeof FAQ_KEYS)[number];
