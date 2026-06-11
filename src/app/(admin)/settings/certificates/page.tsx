import Link from "next/link";
import { db } from "@/lib/db";
import { CertificateList } from "./certificate-list";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function CertificatesPage() {
  await requireAdminPage();

  const certificates = await db.certificate.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  return (
    <div className="px-8 py-8">
      <Link href="/settings" className="text-xs text-zinc-500 underline">
        ← Back to settings
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Certificates</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Logos rendered on Care Label 02 (page 4). A style declares its certificates in the Monday{" "}
          <code className="font-mono">__certificates__1</code> column (comma-separated, e.g.{" "}
          <code className="font-mono">FSC, OEKOTEX</code>); the renderer matches those names against
          this library (case-insensitive) and prints the logos that resolve.
        </p>
      </div>

      <CertificateList
        initialCertificates={certificates.map((c) => ({
          id: c.id,
          name: c.name,
          logo: c.logo,
          active: c.active,
        }))}
      />
    </div>
  );
}
