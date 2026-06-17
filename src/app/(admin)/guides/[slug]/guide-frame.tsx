"use client";

import { useEffect, useRef, useState } from "react";

// Renders a guide's static HTML in an iframe and auto-sizes it to the content
// so it reads as a normal in-page document (no inner scrollbar). The HTML is
// same-origin (served from /guides/), so measuring contentWindow is allowed.
export function GuideFrame({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(1000);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const body = iframe.contentWindow?.document?.body;
      if (body) setHeight(body.scrollHeight + 8);
    };

    const onLoad = () => {
      measure();
      const body = iframe.contentWindow?.document?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => measure());
        observer.observe(body);
      }
    };

    iframe.addEventListener("load", onLoad);
    // Guard against a load that already fired before this effect ran.
    if (iframe.contentWindow?.document?.readyState === "complete") onLoad();

    return () => {
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [src]);

  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
