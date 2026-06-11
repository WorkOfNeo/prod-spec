"use client";

// App-wide leave guard. A page arms it via useLeaveGuard({ when }) and,
// while armed, the three ways out of a page are intercepted:
//
//   1. In-app link clicks (sidebar, breadcrumbs, table links…) — a single
//      capture-phase click listener on `document`, so links the page doesn't
//      own (the admin sidebar) are covered without threading props through
//      the layout. The navigation is held and the page shows its modal.
//   2. Back/forward — on arm, a sentinel history entry is pushed (copying
//      history.state so Next's router internals survive). The first Back
//      lands on the same-URL entry underneath; we re-park and ask. A leave
//      then steps over both entries with history.go(-2).
//   3. Hard exits (tab close, reload, URL bar, external links) — native
//      beforeunload dialog. Browsers ignore custom text/UI there by design.
//
// The HOOK returns { prompting, confirmLeave, cancelLeave } and the page
// renders its own modal — the provider holds no UI, which also keeps the
// page's live data (decided/pending counts) in the modal without ref
// gymnastics. One guard is expected at a time (one page is on screen).
//
// Not intercepted: programmatic router.push/replace from the arming page —
// the page owns those and should disarm (or intend to navigate) first.
// Disarming can leave one spent sentinel entry behind (a single Back
// appears to do nothing once) — accepted cost of catching the back button.

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type PendingNav = { kind: "href"; href: string } | { kind: "pop" };

type NavigationGuardValue = {
  arm: () => () => void;
  pending: PendingNav | null;
  leave: () => void;
  stay: () => void;
};

const NavigationGuardContext = createContext<NavigationGuardValue | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Counted rather than boolean so an unmount/remount race (page A disarms
  // after page B armed) can't strand the guard off.
  const [armedCount, setArmedCount] = useState(0);
  const [pending, setPending] = useState<PendingNav | null>(null);
  // True while a confirmed leave plays out — the listeners must not re-trap
  // the navigation they themselves triggered.
  const leavingRef = useRef(false);
  const armed = armedCount > 0;

  const arm = useCallback(() => {
    leavingRef.current = false;
    setArmedCount((n) => n + 1);
    return () => {
      setArmedCount((n) => Math.max(0, n - 1));
      setPending(null);
    };
  }, []);

  // ---------- 1. In-app link clicks (capture phase) ----------
  useEffect(() => {
    if (!armed) return;
    function onClickCapture(e: MouseEvent) {
      if (leavingRef.current || e.defaultPrevented) return;
      // Modified / non-primary clicks open new tabs — nothing to guard.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const rawHref = anchor.getAttribute("href");
      if (!rawHref || rawHref.startsWith("#")) return;
      const url = new URL(anchor.href, window.location.href);
      // External origins hard-navigate → beforeunload covers them.
      if (url.origin !== window.location.origin) return;
      // API links (PDF previews/downloads) are not page navigations.
      if (url.pathname.startsWith("/api/")) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending({ kind: "href", href: url.pathname + url.search + url.hash });
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [armed]);

  // ---------- 2. Back/forward (popstate sentinel) ----------
  useEffect(() => {
    if (!armed) return;
    // Copy history.state: Next keys its router state off it — a foreign
    // state object would break restore on the duplicated entry.
    window.history.pushState(window.history.state, "", window.location.href);
    function onPopState() {
      if (leavingRef.current) return;
      // Re-park on the same URL, then ask.
      window.history.pushState(window.history.state, "", window.location.href);
      setPending({ kind: "pop" });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [armed]);

  // ---------- 3. Hard exits ----------
  useEffect(() => {
    if (!armed) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [armed]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    if (!pending) return;
    leavingRef.current = true;
    setPending(null);
    if (pending.kind === "href") {
      router.push(pending.href);
    } else {
      // Step over the real entry AND the re-parked sentinel.
      window.history.go(-2);
    }
  }, [pending, router]);

  const value = useMemo(
    () => ({ arm, pending, leave, stay }),
    [arm, pending, leave, stay],
  );

  return (
    <NavigationGuardContext.Provider value={value}>{children}</NavigationGuardContext.Provider>
  );
}

export function useLeaveGuard({ when }: { when: boolean }): {
  // A held navigation is waiting on the user — render your modal now.
  prompting: boolean;
  // Replay the held navigation (link target or history step) and disarm.
  confirmLeave: () => void;
  // Drop the held navigation and keep the user on the page.
  cancelLeave: () => void;
} {
  const ctx = useContext(NavigationGuardContext);
  if (!ctx) {
    throw new Error("useLeaveGuard requires <NavigationGuardProvider> (mounted in the admin layout)");
  }

  useEffect(() => {
    if (!when) return;
    return ctx.arm();
  }, [when, ctx]);

  return {
    prompting: when && ctx.pending !== null,
    confirmLeave: ctx.leave,
    cancelLeave: ctx.stay,
  };
}
