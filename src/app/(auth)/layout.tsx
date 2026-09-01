/**
 * The signed-out shell.
 *
 * Deliberately its own route group, sharing nothing with `(app)`. The sign-in
 * form previously lived inside the application layout, which meant it rendered
 * with the full navigation sidebar behind it — advertising every screen in the
 * product to someone who had not yet proved who they were, and, once the page
 * guard was added, redirecting to itself forever.
 *
 * A layout with no navigation cannot leak navigation.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-stage flex min-h-screen flex-col">
      {/* Decorative only: hidden from assistive technology, and both layers are
          driven entirely by CSS so they cost no JavaScript on the one route
          where the visitor is waiting to get in. */}
      <div className="auth-aurora" aria-hidden="true">
        <i />
      </div>
      <div className="auth-grid" aria-hidden="true" />
      {children}
    </div>
  );
}
