"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Scroll-triggered "load more" for the Queued outputs list. The rows are
// server-rendered (they carry bulk-joined customer/supplier names), so paging is
// done by growing the ?queued= param: an IntersectionObserver on the sentinel
// navigates to the next page (scroll:false keeps the position) as it comes into
// view; the button is the manual fallback. The parent gives this a `key={href}`
// so it remounts once the next page has rendered — resetting `fired`/`loading`
// for the following page without any setState-in-effect.
export function QueuedLoadMore({ href, remaining }: { href: string; remaining: number }) {
  const router = useRouter();
  const sentinel = useRef<HTMLDivElement>(null);
  const fired = useRef(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !fired.current) {
          fired.current = true;
          setLoading(true);
          router.push(href, { scroll: false });
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [href, router]);

  return (
    <div ref={sentinel} className="mt-2 flex justify-center">
      <button
        type="button"
        onClick={() => {
          if (fired.current) return;
          fired.current = true;
          setLoading(true);
          router.push(href, { scroll: false });
        }}
        disabled={loading}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
      >
        {loading ? "Loading…" : `Load ${remaining.toLocaleString()} more`}
      </button>
    </div>
  );
}
