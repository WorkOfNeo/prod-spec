import "isomorphic-fetch";
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";

let cachedClient: Client | null = null;

// The three variables getGraphClient actually requires. Exported as a list so
// the "what's missing?" message below can name them without drifting from the
// check.
const GRAPH_ENV_VARS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] as const;

// Can we talk to Graph at all?
//
// This is the gate every SUPPLIER-FOLDER surface wants — the folder is reached
// through a sharing link (shares.ts) and a drive-item walk, and none of that
// touches a site id.
//
// It is deliberately NOT isSharepointConfigured() from publish-approved-job.ts.
// That one additionally requires SHAREPOINT_SITE_ID, which is used in exactly
// one place: client.ts, for the configured-site upload the publish path does.
// Using it to gate supplier-folder work meant that with the Azure credentials
// present but no site id, the per-style folder check and the PO delivery ledger
// both reported "SharePoint credentials aren't configured" — while the delivery
// audit, which gates on nothing and just calls Graph, worked perfectly. Same
// environment, same folder, opposite answers.
export function isGraphConfigured(): boolean {
  return GRAPH_ENV_VARS.every((k) => Boolean(process.env[k]));
}

// Which of them are absent — so a "not configured" message can say WHICH
// variable to set instead of sending someone to check all of them.
export function missingGraphEnvVars(): string[] {
  return GRAPH_ENV_VARS.filter((k) => !process.env[k]);
}

export function getGraphClient(): Client {
  if (cachedClient) return cachedClient;

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Microsoft Graph credentials missing — set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET",
    );
  }

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  cachedClient = Client.initWithMiddleware({ authProvider });
  return cachedClient;
}
