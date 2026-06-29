// The signup page itself is a Client Component, which cannot export
// `metadata`. This server wrapper sets the browser-tab title for the route.
export const metadata = { title: "Sign up" };

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
