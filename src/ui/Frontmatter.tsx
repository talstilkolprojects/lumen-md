import { t } from "../i18n";

interface Props {
  data: Record<string, unknown> | null;
}

const KNOWN_KEYS = ["title", "subtitle", "author", "date", "tags"];

export function Frontmatter({ data }: Props) {
  if (!data) return null;

  const title = stringOf(data.title);
  const subtitle = stringOf(data.subtitle);
  const author = stringOf(data.author);
  const date = stringOf(data.date);
  const tags = arrayOf(data.tags);

  const extra = Object.entries(data).filter(
    ([k]) => !KNOWN_KEYS.includes(k),
  );

  if (!title && !author && !date && tags.length === 0 && extra.length === 0) {
    return null;
  }

  return (
    <header
      style={{
        marginBottom: "2rem",
        paddingBottom: "1.25rem",
        borderBottom: "1px solid hsl(var(--border))",
      }}
    >
      {title && (
        <div
          style={{
            fontFamily:
              "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
            fontSize: "0.72rem",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "hsl(var(--accent))",
            fontWeight: 600,
            marginBottom: "0.5rem",
          }}
        >
          {t("frontmatter.label")}
        </div>
      )}
      {subtitle && (
        <p
          style={{
            margin: 0,
            color: "hsl(var(--fg-muted))",
            fontSize: "1rem",
            fontStyle: "italic",
          }}
        >
          {subtitle}
        </p>
      )}
      <div
        style={{
          marginTop: "0.75rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem 1.25rem",
          alignItems: "center",
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif",
          fontSize: "13px",
          color: "hsl(var(--fg-muted))",
        }}
      >
        {author && (
          <span>
            {/* no extra opacity on fg-muted — it dropped contrast below WCAG AA */}
            <span>{t("frontmatter.by")} </span>
            <span style={{ color: "hsl(var(--fg))", fontWeight: 500 }}>
              {author}
            </span>
          </span>
        )}
        {date && <span>{date}</span>}
        {tags.length > 0 && (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {tags.map((t, i) => (
              <span
                key={i}
                style={{
                  padding: "1px 8px",
                  borderRadius: 999,
                  border: "1px solid hsl(var(--accent) / 0.3)",
                  background: "hsl(var(--accent) / 0.08)",
                  // fg (not accent) for the label — 11px text on a tinted
                  // pill needs full AA contrast; accent stays in the chrome.
                  color: "hsl(var(--fg))",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                #{t}
              </span>
            ))}
          </span>
        )}
        {extra.map(([k, v]) => (
          <span key={k}>
            <span>{k}:</span>{" "}
            <span style={{ color: "hsl(var(--fg))" }}>{stringOf(v)}</span>
          </span>
        ))}
      </div>
    </header>
  );
}

function stringOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return "";
}

function arrayOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
