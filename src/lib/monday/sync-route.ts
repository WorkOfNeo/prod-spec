import { NextResponse } from "next/server";
import { serr } from "./sync-log";

// Wrap a sync/sink trigger so a thrown error becomes a readable JSON 500
// (surfaced in the Sync tab UI as `error: <message>`) AND a stderr line on
// Railway — instead of an unhandled 500 that shows up as a bare status
// code in the UI and nothing actionable in the logs.
export async function runAndRespond(
  scope: string,
  fn: () => Promise<unknown>,
): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (err) {
    serr(scope, "request failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 },
    );
  }
}
