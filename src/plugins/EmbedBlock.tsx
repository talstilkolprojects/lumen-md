import { t } from "../i18n";
import { embedFor } from "./embedUrl";

interface Props {
  source: string;
}

export default function EmbedBlock({ source }: Props) {
  // Allow multi-line; render the first non-empty URL only.
  const url = source.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const embed = embedFor(url);

  if (!embed) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.embed.unrecognized")}
        </div>
        {/^https:\/\//i.test(url) && (
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "hsl(var(--accent))", fontSize: 11 }}>
            {t("block.embed.open")}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>{embed.title}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "hsl(var(--accent))", fontSize: 11 }}
        >
          {t("block.embed.open")}
        </a>
      </div>
      <div
        style={{
          position: "relative",
          paddingBottom: `${embed.paddingPct}%`,
          height: 0,
          overflow: "hidden",
        }}
      >
        <iframe
          src={embed.src}
          title={embed.title}
          loading="lazy"
          allow={embed.allow}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            border: 0,
          }}
        />
      </div>
    </div>
  );
}
