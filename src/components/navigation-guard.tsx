"use client";

// App-wide leave guard. A page arms it via useLeaveGuard({ when, render })
// and, while armed, the three ways out of the page are intercepted:
//
//   1. In-app link clicks (sidebar, breadcrumbs, table links…) — a single
//      capture-phase click listener on `document`, so links the page doesn't
//      own (the admin sidebar) are covered without threading props through
//      the layout. The navigation is held and `render` shows the page's
//      custom modal with leave/stay callbacks.
//   2. Back/forward — on arm, a sentinel history entry is pushed (copying
//      history.state so Next's router internals survive). The first Back
//      lands on the same-URL entry underneath; we re-park and ask. A leave
//      then steps over both entries with history.go(-2).
//   3. Hard exits (tab close, reload, URL bar, external links) — native
//      beforeunload dialog. Browsers ignore custom text/UI there by design.
//
// Not intercepted: programmatic router.push/replace from the arming page —
// the page owns those and should disarm (or intend to navigate) first.
// One guard is active at a time; the latest arm wins.
//
// The provider mounts once in the (admin) layout. Disarming can leave one
// spent sentinel entry behind (a single Back appears to do nothing once) —
// accepted cosmetic cost of catching the back button.

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

export type LeaveGuardRender = (leave: () => void, stay: () => void) => ReactNode;

type GuardRegistration = {
  renderRef: MutableRefObject<LeaveGuardRender>;
};

type PendingNav = { kind: "href"; href: string } | { kind: "pop" };

const NavigationGuardContext = createContext<{
  arm: (reg: GuardRegistration) => () => void;
} | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [guard, setGuard] = useState<GuardRegistration | null>(null);
  const [pending, setPending] = useState<PendingNav | null>(null);
  // True while a confirmed leave plays out — the listeners must not re-trap
  // the navigation they themselves triggered.
  const leavingRef = useRef(false);

  const arm = useCallback((reg: GuardRegistration) => {
    leavingRef.current = false;
    setGuard(reg);
    return () => {
      setGuard((current) => (current === reg ? null : current));
      setPending(null);
    };
  }, []);

  // ---------- 1. In-app link clicks (capture phase) ----------
  useEffect(() => {
    if (!guard) return;
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
  }, [guard]);

  // ---------- 2. Back/forward (popstate sentinel) ----------
  useEffect(() => {
    if (!guard) return;
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
  }, [guard]);

  // ---------- 3. Hard exits ----------
  useEffect(() => {
    if (!guard) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guard]);

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

  return (
    <NavigationGuardContext.Provider value={{ arm }}>
      {children}
      {guard && pending ? guard.renderRef.current(leave, stay) : null}
    </NavigationGuardContext.Provider>
  );
}

export function useLeaveGuard({ when, render }: { when: boolean; render: LeaveGuardRender }) {
  const ctx = useContext(NavigationGuardContext);
  if (!ctx) {
    throw new Error("useLeaveGuard requires <NavigationGuardProvider> (mounted in the admin layout)");
  }
  // Ref keeps the latest render closure without re-arming on every render.
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    if (!when) return;
    return ctx.arm({ renderRef });
  }, [when, ctx]);
}
