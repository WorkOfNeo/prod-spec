// The login page itself is a Client Component, which cannot export
// `metadata`. This server wrapper sets the browser-tab title for the route.
export const metadata = { title: "Log in" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
