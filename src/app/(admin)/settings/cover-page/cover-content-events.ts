// Client-side signal that the cover prose was just saved with a real change.
//
// The two editors (global cover block, per-spec General information) and the
// regenerate panel are sibling client components rendered by a server page, so
// they share no React state. Rather than lift a provider around a server
// subtree just to carry one boolean, the editors dispatch this event and the
// panel listens — the panel's banner flips on immediately instead of waiting
// for a reload.
//
// The DURABLE source of truth is still the DB (AppSetting coverContentStamp,
// see coverContentIsStale): the event only covers the current page session, and
// the server re-seeds the banner on every render. If the event were ever
// dropped, the banner would still be correct on the next load.
export const COVER_CONTENT_SAVED_EVENT = "prodspec:cover-content-saved";

export function announceCoverContentSaved(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COVER_CONTENT_SAVED_EVENT));
}
