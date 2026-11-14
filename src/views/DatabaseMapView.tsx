/**
 * The database block's map view (plan 4.11): one marker per note that has
 * coordinates (`location: "32.08, 34.78"`, `[lat, lng]`, `{lat, lng}`, or
 * `lat` + `lng` properties; `location:` in the spec picks the column).
 *
 * This component is loaded with React.lazy from DatabaseBlock, and Leaflet
 * itself (JS, CSS, marker images) only when the view is first shown — the
 * same self-hosted loader as the ```map block, so nothing joins the startup
 * bundle.
 */

import { useEffect, useMemo, useRef } from "react";
import { displayValue, rowLatLng, type DatabaseRow, type DatabaseSpec } from "./database";
import { getLeaflet } from "../plugins/map/leaflet";
import { t } from "../i18n";

const titleOf = (row: DatabaseRow) => (typeof row.fm.title === "string" && row.fm.title) || row.basename;

export interface MapPoint {
  row: DatabaseRow;
  lat: number;
  lng: number;
}

/** The rows that have coordinates, with them. */
export function mapPoints(rows: readonly DatabaseRow[], spec: Pick<DatabaseSpec, "location">): MapPoint[] {
  const out: MapPoint[] = [];
  for (const row of rows) {
    const p = rowLatLng(row, spec);
    if (p) out.push({ row, ...p });
  }
  return out;
}

export default function DatabaseMapView({ rows, spec, fields }: { rows: DatabaseRow[]; spec: DatabaseSpec; fields: string[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const points = useMemo(() => mapPoints(rows, spec), [rows, spec]);
  const missing = rows.length - points.length;

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;
    void getLeaflet().then((L) => {
      if (cancelled || !ref.current) return;
      const m = L.map(ref.current, { scrollWheelZoom: false });
      map = m;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);
      for (const p of points) {
        // Popup content is built from DOM nodes (textContent), never from HTML strings.
        const box = document.createElement("div");
        box.dir = "auto";
        const link = document.createElement("a");
        link.href = `#${encodeURIComponent(p.row.path)}`;
        link.textContent = titleOf(p.row);
        link.addEventListener("click", (e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: p.row.path } }));
        });
        box.appendChild(link);
        for (const f of fields.filter((x) => x !== "title").slice(0, 3)) {
          const v = displayValue(p.row.fm[f]);
          if (!v) continue;
          const line = document.createElement("div");
          line.textContent = `${f}: ${v}`;
          box.appendChild(line);
        }
        L.marker([p.lat, p.lng], { title: titleOf(p.row), alt: titleOf(p.row) }).addTo(m).bindPopup(box);
      }
      if (points.length === 1) m.setView([points[0].lat, points[0].lng], 12);
      else m.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [24, 24] });
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points, fields]);

  if (points.length === 0) {
    return (
      <div style={{ padding: 12, color: "hsl(var(--fg-muted))", fontSize: 12 }} data-testid="database-map-empty">
        {t("db.map.noLocations", { field: spec.location ?? "location" })}
      </div>
    );
  }
  return (
    <div>
      <div ref={ref} data-testid="database-map" role="region" aria-label={t("db.map.label", { count: points.length })} style={{ blockSize: 360, inlineSize: "100%", borderRadius: 6 }} />
      {missing > 0 && <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", marginBlockStart: 4 }}>{t("db.map.missing", { count: missing })}</div>}
    </div>
  );
}
