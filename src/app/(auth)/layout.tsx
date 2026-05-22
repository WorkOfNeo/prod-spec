export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Prod Spec</h1>
          <p className="mt-1 text-xs text-zinc-500">Contrast Company internal tool</p>
        </div>
        {children}
      </div>
    </div>
  );
}
