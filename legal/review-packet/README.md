# Free legal review packet for Lumen (W6.37)

The Hebrew cover note, [README.he.md](README.he.md), is what the clinic gets. This page is the English summary for the maintainers.

- **Ask:** a free written opinion from an Israeli university technology and privacy law clinic. This is not a request for representation.
- **Questions** (README.he.md, "השאלות"):
  1. `PRIVACY.he.md` against Amendment 13's notice duty and rights.
  2. Whether the share server or the feedback creates a "database" with registration or security duties.
  3. Whether the share server's privacy impact assessment is sufficient.
  4. Transfer abroad (Vercel, Cloudflare).
  5. Sefaria's terms and our per-text licence rule.
  6. Non-commercial model licences.
  7. Whether ivrit.ai's training-data licence reaches the distilled Ozen v1 model (#520 keeps Ozen off until then).
  8. The "not legal advice" disclaimer and liability.
- **Packet:** `node scripts/legal-packet.mjs` writes `dist-legal-packet/`. It holds the 15 documents listed in `DOCS` and a generated `data-licences.md`, frozen at one commit, with `00-INDEX.md` listing the SHA-256 of each. `node scripts/legal-packet.mjs --check` fails if a listed document is missing.
- **Afterwards:** every recommendation goes into [recommendations.md](recommendations.md) and becomes a plan task, marked done (with its PR) or declined (with a reason). That is the plan's acceptance.
- **Outreach:** [outreach.he.md](outreach.he.md), which Tal sends. The first draft goes to the Tel Aviv University Privacy Clinic. The second goes to the University of Haifa's Law, Technology and Cyber Clinic. The clinic research, with each clinic's own page, is the table at the end of README.he.md.
