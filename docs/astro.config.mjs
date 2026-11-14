import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Lumen's user docs. Hosted at docs.lumen.app — point your CNAME there.
//
// `npm install && npm run dev` from inside `docs/` to author. The site
// builds to `docs/dist/` for any static host (Cloudflare Pages, Netlify,
// GitHub Pages).
export default defineConfig({
  site: "https://docs.lumen.app",
  integrations: [
    starlight({
      title: "Lumen Docs",
      description: "Markdown, illuminated. The user manual.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/talstilkol/lumen-md" },
      ],
      // Content lives at the collection root (no en/ folder), so English is
      // the root locale; Hebrew pages fall back to English until translated.
      locales: {
        root: { label: "English", lang: "en" },
        he: { label: "עברית", lang: "he" },
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Welcome to Lumen", slug: "getting-started/welcome" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
          ],
        },
        {
          label: "Editor modes",
          items: [
            { label: "Source / Split / Preview / WYSIWYG", slug: "editor/modes" },
            { label: "Smart Insert", slug: "editor/smart-insert" },
          ],
        },
        {
          label: "Markdown blocks",
          items: [{ autogenerate: { directory: "blocks" } }],
        },
        {
          label: "Workspace",
          items: [
            { label: "Database views", slug: "workspace/database-views" },
            { label: "Search (BM25 + Smart)", slug: "workspace/search" },
            { label: "Vault Doctor", slug: "workspace/doctor" },
          ],
        },
        {
          label: "Collaboration",
          items: [
            { label: "Real-time WebRTC", slug: "collab/webrtc" },
            { label: "End-to-end encryption", slug: "collab/encryption" },
          ],
        },
        {
          label: "AI",
          items: [
            { label: "Auto-tag + link suggestions", slug: "ai/agents" },
            { label: "Local LLM (web-llm)", slug: "ai/local-llm" },
            { label: "AI cost: usage meter + answer cache", slug: "ai/cost" },
            { label: "Research + citation checks", slug: "ai/research" },
            { label: "MCP integration (Claude Desktop, Cursor)", slug: "ai/mcp" },
          ],
        },
        {
          label: "Plugins + Templates",
          items: [
            { label: "Plugin SDK", slug: "plugins/sdk" },
            { label: "Plugin gallery", slug: "plugins/gallery" },
            { label: "Plugin signing keys", slug: "plugins/signing" },
            { label: "Templates marketplace", slug: "plugins/templates" },
            { label: "Web Clipper extension", slug: "plugins/web-clipper" },
          ],
        },
        {
          label: "Sync",
          items: [
            { label: "Git sync", slug: "sync/git" },
            { label: "Cloud sync (Dropbox, Drive)", slug: "sync/cloud" },
            { label: "Encrypted sync (E2EE)", slug: "sync/e2ee" },
            { label: "Read-mode publishing", slug: "sync/publish" },
          ],
        },
        {
          label: "Account",
          items: [
            { label: "Signing in", slug: "account/sign-in" },
            { label: "Single sign-on (SSO)", slug: "account/sso" },
            { label: "Organization settings", slug: "account/organization" },
          ],
        },
        {
          label: "Security",
          items: [
            { label: "Secrets and encryption", slug: "security/vault" },
          ],
        },
        {
          label: "Self-hosting",
          items: [
            { label: "Docker compose bundle", slug: "self-hosting/docker" },
          ],
        },
      ],
    }),
  ],
});
