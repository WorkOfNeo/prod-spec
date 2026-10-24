// Master switch for change requests (design docs/plans/change-requests.md §2,
// rail 4). OFF by default: with the flag unset there is no nav entry, the
// /requests pages 404 and every change-request API route 404s, so merging the
// feature to main is inert until CHANGE_REQUESTS_ENABLED=true is set on the
// environment that should run it.
//
// Server-side only — components receive the resolved boolean as props; never
// read process.env in client code.
export function changeRequestsEnabled(): boolean {
  return process.env.CHANGE_REQUESTS_ENABLED === "true";
}
