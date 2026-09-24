/**
 * The activity feed stores a small amount of markup (`<strong>Name</strong>`),
 * so any value interpolated into it has to be escaped first. Kept in one place
 * so the API and the account flows cannot disagree about the rules.
 */
export const escapeText = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
