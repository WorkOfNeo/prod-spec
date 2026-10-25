// What the sidebar shows, by role and feature flag. Pure data — the server
// layout builds it and hands it to the client sidebar (icons go by name, since
// components can't cross the server/client boundary).
//
// ADMIN sees everything. REVIEWERs are scoped to their work, the styles pages,
// Delivery, Checks and the cover-page editor — hiding a link is not access
// control: every admin-only page also enforces it server-side
// (requireAdminPage), and the reviewer pages gate on canReview.

export type NavIcon =
  | "tasks"
  | "reviews"
  | "rejections"
  | "styles"
  | "delivery"
  | "checks"
  | "requests"
  | "combos"
  | "jobs"
  | "automation"
  | "admin"
  | "devData"
  | "prodSpecs"
  | "outputBuilder"
  | "poBarcodes"
  | "customers"
  | "suppliers"
  | "users"
  | "coverPage"
  | "guides";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Highlight for this path prefix instead of the href's own. */
  match?: string;
  /** The live "waiting on you" count (My tasks). */
  badge?: "tasks";
};

export type NavGroup = { label?: string; items: NavItem[] };

export type NavFlags = { followThrough: boolean; changeRequests: boolean; devData: boolean };

export type SettingsLink = { href: string; label: string };

export function buildNav(isAdmin: boolean, flags: NavFlags): NavGroup[] {
  const work: NavItem[] = flags.followThrough
    ? [
        { href: "/dashboard", label: "My tasks", icon: "tasks", badge: "tasks" },
        // The review queue — every style awaiting review, grouped per style.
        { href: "/reviews/dashboard", label: "Reviews", icon: "reviews", match: "/reviews" },
      ]
    : [];
  if (isAdmin) work.push({ href: "/settings/rejection-log", label: "Rejection log", icon: "rejections" });

  if (!isAdmin) {
    return [
      ...(work.length ? [{ items: work }] : []),
      {
        label: "Production",
        items: [
          { href: "/styles", label: "Styles", icon: "styles" },
          // "Did the supplier actually get the files?" is a reviewer's question too.
          { href: "/delivery", label: "Delivery", icon: "delivery" },
          // Self-service folder audits — a question about an order being worked on.
          { href: "/checks", label: "Checks", icon: "checks" },
          // Reviewers own the bundle's front matter prose; the page gates on canReview.
          { href: "/settings/cover-page", label: "Cover page", icon: "coverPage" },
        ],
      },
    ];
  }

  const production: NavItem[] = [
    { href: "/styles", label: "Styles", icon: "styles" },
    // Delivery is keyed on the purchase order, not the style.
    { href: "/delivery", label: "Delivery", icon: "delivery" },
    // Checks mirrors Delivery: is anything in the supplier's folder wrong?
    { href: "/checks", label: "Checks", icon: "checks" },
  ];
  // Change requests, behind CHANGE_REQUESTS_ENABLED.
  if (flags.changeRequests) production.push({ href: "/requests", label: "Requests", icon: "requests" });
  production.push(
    { href: "/combos", label: "New combos", icon: "combos" },
    { href: "/jobs", label: "Jobs", icon: "jobs" },
    { href: "/automation", label: "Automation", icon: "automation" },
    { href: "/admin", label: "Admin", icon: "admin" },
  );
  // Load production POs into a development environment; only where DEV_DATA_LOADER=true.
  if (flags.devData) production.push({ href: "/dev-data", label: "Dev data", icon: "devData" });

  return [
    ...(work.length ? [{ items: work }] : []),
    { label: "Production", items: production },
    {
      label: "Build",
      items: [
        { href: "/prod-specs", label: "Prod specs", icon: "prodSpecs" },
        { href: "/output-builder", label: "Output builder", icon: "outputBuilder" },
        { href: "/po-eans", label: "PO barcodes", icon: "poBarcodes" },
      ],
    },
    {
      label: "Directory",
      items: [
        { href: "/customers", label: "Customers", icon: "customers" },
        { href: "/suppliers", label: "Suppliers", icon: "suppliers" },
        { href: "/users", label: "Users", icon: "users" },
      ],
    },
  ];
}

/** Configuration and reference data, folded under Settings (admins only). */
export function settingsLinks(changeRequests: boolean): SettingsLink[] {
  const items: SettingsLink[] = [
    { href: "/settings", label: "General" },
    { href: "/settings/cover-page", label: "Cover page" },
    { href: "/settings/trims", label: "Trims" },
    { href: "/settings/approved", label: "Approved & delivery" },
    { href: "/settings/style-dashboard", label: "Style dashboard" },
    { href: "/settings/notifications", label: "Notifications" },
    { href: "/settings/review-activity", label: "Review activity" },
    { href: "/settings/system-prompts", label: "Prompts" },
    ...(changeRequests ? [{ href: "/settings/agent-memory", label: "Agent memory" }] : []),
    { href: "/settings/statistics", label: "Review stats" },
    { href: "/monday", label: "Monday" },
    { href: "/settings/care-labels", label: "Care labels" },
    { href: "/settings/info-area-sizes", label: "Info area sizes" },
    { href: "/settings/washcare-symbols", label: "Wash care symbols" },
    { href: "/settings/colour-aliases", label: "Colour aliases" },
    { href: "/settings/certificates", label: "Certificates" },
    { href: "/settings/images", label: "Images" },
    { href: "/settings/qr-codes", label: "QR codes" },
    { href: "/translations", label: "Translations" },
    { href: "/countries", label: "Countries" },
    { href: "/languages", label: "Languages" },
    { href: "/business-areas", label: "Business areas" },
  ];
  return items;
}

/** Whether a nav link is the current page (or a page under it). */
export function isActive(pathname: string, href: string, match?: string): boolean {
  const base = match ?? href;
  if (base === "/settings") return pathname === "/settings";
  return pathname === base || pathname.startsWith(`${base}/`);
}
