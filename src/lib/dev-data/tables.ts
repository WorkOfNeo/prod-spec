// What the dev data loader copies from production, and how each table is scoped.
//
// Reference tables are copied whole: everything a style needs around it to
// render, review and deliver (users and their logins, customers, prod specs,
// layouts, settings, translations …). They're small — under 15 MB together.
//
// Per-PO tables follow the purchase orders you load: the styles on those POs
// and everything hanging off them. job_assets carries the PDFs (13 GB across
// all of production), which is why the loader works per PO.
//
// Deliberately NOT copied: sessions and verifications, presence, view logs,
// notifications, email logs and events, cron/sync/bulk-run logs, folder-check
// sweeps, change requests, Monday webhooks and the Monday item mirror
// (monday_ghost_items, 66 MB — style fields live in styles.rawData).

export const REFERENCE_TABLES = [
  "users",
  "accounts",
  "business_areas",
  "customers",
  "customer_business_area_combos",
  "suppliers",
  "supplier_contacts",
  "qr_images",
  "prod_specs",
  "prod_spec_images",
  "prod_spec_suppliers",
  "output_layouts",
  "output_layout_revisions",
  "layout_images",
  "cover_page_images",
  "templates",
  "app_settings",
  "care_labels",
  "wash_symbols",
  "certificates",
  "countries",
  "languages",
  "translations",
  "info_area_sizes",
  "doc_types",
  "system_prompts",
  "trim_concept_rows",
  "monday_column_config",
  "monday_ghost_boards",
  "monday_ghost_columns",
  "monday_ghost_dropdown_options",
  "supplier_send_batches",
] as const;

/** How a per-PO table is narrowed to the loaded POs. */
export type PoScope = "po" | "style" | "job" | "ticket";

export const PO_TABLES: ReadonlyArray<{ table: string; scope: PoScope }> = [
  { table: "styles", scope: "po" },
  { table: "style_eans", scope: "style" },
  { table: "style_manual_trim_uploads", scope: "style" },
  { table: "style_output_field_values", scope: "style" },
  { table: "style_output_ignores", scope: "style" },
  { table: "style_output_line_values", scope: "style" },
  { table: "supplier_shares", scope: "style" },
  { table: "output_deliveries", scope: "style" },
  { table: "supplier_send_queue_items", scope: "style" },
  { table: "jobs", scope: "style" },
  { table: "job_assets", scope: "job" },
  { table: "review_actions", scope: "job" },
  { table: "logs", scope: "job" },
  { table: "rejection_tickets", scope: "style" },
  { table: "rejection_attachments", scope: "ticket" },
  { table: "po_delivery_checks", scope: "po" },
];

/** The column each scope filters on. */
export const SCOPE_COLUMN: Record<PoScope, string> = {
  po: "poNumber",
  style: "styleId",
  job: "jobId",
  ticket: "ticketId",
};
