// Runs during HTML parsing on a hard load. On the client the tag is inert
// (type="text/plain"), so React doesn't warn about rendering a script.
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
