// Runs once when a Next.js server starts.
//
// Only job today: in a development environment (DEV_DATA_LOADER=true), start
// the dev data loader's background sync. Production never sets the flag, so
// there this returns before importing anything.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DEV_DATA_LOADER !== "true") return;
  const { startDevDataSync } = await import("./lib/dev-data/scheduler");
  startDevDataSync();
}
