import { lazy, Suspense, useState } from "react";
import { LogIn, LogOut, AlertTriangle } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { describeAuthStatus } from "../auth/authStatus";
import { t } from "../i18n";

// The dialog loads when it is first opened (startup budget).
const AuthDialog = lazy(() => import("./AuthDialog").then((m) => ({ default: m.AuthDialog })));

/**
 * Toolbar entry-point for sign in / out. Renders a tiny pill on the right
 * side of the title bar — anonymous users see "Sign in", authenticated
 * users see their initial / avatar with a click-to-sign-out menu.
 */

export function AuthButton() {
  const { status, user, signOut, provider, error } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  if (status === "loading") {
    return null;
  }

  if (status === "authenticated" && user) {
    const initial = (user.name ?? user.email ?? "?").trim().charAt(0).toUpperCase();
    return (
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("auth.accountMenu", { user: user.email ?? user.name ?? user.id })}
          title={user.email ?? user.name ?? user.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 999,
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            cursor: "pointer",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              width={20}
              height={20}
              style={{ borderRadius: 999, objectFit: "cover" }}
            />
          ) : (
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                background: "var(--gradient-brand)",
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {initial}
            </span>
          )}
          <span
            style={{
              maxWidth: 100,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user.name ?? user.email}
          </span>
        </button>
        {menuOpen && (
          <div
            role="menu"
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              insetInlineEnd: 0,
              minWidth: 200,
              background: "hsl(var(--bg))",
              border: "1px solid hsl(var(--border-strong))",
              borderRadius: 10,
              boxShadow: "var(--shadow-lg)",
              zIndex: 100,
              padding: "6px 0",
            }}
            onMouseLeave={() => setMenuOpen(false)}
          >
            <div
              style={{
                padding: "6px 12px 8px",
                fontSize: 11,
                color: "hsl(var(--fg-muted))",
                borderBottom: "1px solid hsl(var(--border))",
              }}
            >
              {t("auth.signedInAs")}
              <div style={{ color: "hsl(var(--fg))", fontWeight: 500, fontSize: 12, marginTop: 2 }}>
                {user.email ?? user.name ?? user.id}
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setMenuOpen(false);
                await signOut();
              }}
              style={menuItemStyle}
            >
              <LogOut size={13} aria-hidden /> {t("auth.signOut")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Signed out / not configured / error: the pill opens the dialog and its
  // tooltip says *why* the user is signed out (PRODUCT_IMPROVEMENT 1.4).
  const described = describeAuthStatus({ status, providerName: provider.name, error });
  const isError = described.kind === "error";
  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        aria-label={`${t("auth.signIn")} — ${described.title}`}
        title={`${described.title}: ${described.hint}`}
        data-auth-status={described.kind}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          border: isError ? "1px solid hsl(var(--danger) / 0.6)" : "1px solid hsl(var(--border))",
          borderRadius: 999,
          background: "transparent",
          color: "hsl(var(--fg))",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {isError ? (
          <AlertTriangle size={13} aria-hidden style={{ color: "hsl(var(--danger))" }} />
        ) : (
          <LogIn size={13} aria-hidden />
        )}{" "}
        {t("auth.signIn")}
      </button>
      {dialogOpen && (
        <Suspense fallback={null}>
          <AuthDialog open onClose={() => setDialogOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 12px",
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg))",
  fontSize: 13,
  cursor: "pointer",
  textAlign: "start",
};
