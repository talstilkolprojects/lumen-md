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
            { label: "Desktop app updates", slug: "getting-started/desktop-updates" },
            { label: "Install Lumen", slug: "getting-started/install", translations: { he: "התקנת Lumen" } },
            { label: "Keyboard shortcuts", slug: "getting-started/shortcuts", translations: { he: "קיצורי מקלדת" } },
            { label: "Send feedback", slug: "getting-started/feedback" },
          ],
        },
        {
          label: "Editor modes",
          items: [
            { label: "Source / Split / Preview / WYSIWYG", slug: "editor/modes" },
            { label: "Smart Insert", slug: "editor/smart-insert" },
            { label: "Accessibility", slug: "editor/accessibility", translations: { he: "נגישות" } },
            { label: "Touch and phones", slug: "editor/touch", translations: { he: "מגע וטלפונים" } },
            { label: "Hebrew and right-to-left", slug: "editor/hebrew", translations: { he: "עברית ומימין לשמאל" } },
            { label: "Settings", translations: { he: "הגדרות" }, slug: "editor/settings" },
            { label: "Hebrew and right-to-left", translations: { he: "עברית וכתיבה מימין לשמאל" }, slug: "editor/hebrew-rtl" },
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
            { label: "Database formulas + map", slug: "workspace/database-formulas", translations: { he: "נוסחאות במסד נתונים ותצוגת מפה" } },
            { label: "Fill properties with AI", translations: { he: "מילוי מאפיינים ב-AI" }, slug: "workspace/ai-autofill" },
            { label: "Search (BM25 + Smart)", slug: "workspace/search" },
            { label: "Search operators and #tags", slug: "workspace/search-operators", translations: { he: "אופרטורי חיפוש ו-#תגיות" } },
            { label: "Vault Doctor", slug: "workspace/doctor" },
            { label: "Quick capture (inbox)", slug: "workspace/quick-capture", translations: { he: "לכידה מהירה (תיבת דואר נכנס)" } },
            { label: "PDF reader and highlights", slug: "workspace/pdf-reader", translations: { he: "קורא PDF והדגשות" } },
            { label: "Large vaults and long notes", slug: "workspace/large-vaults", translations: { he: "כספות גדולות ופתקים ארוכים" } },
            { label: "Canvas (Excalidraw)", slug: "workspace/canvas", translations: { he: "קנבס (Excalidraw)" } },
            { label: "Export and import", slug: "workspace/export-import", translations: { he: "ייצוא וייבוא" } },
            { label: "Tasks across the vault", slug: "workspace/tasks" },
            { label: "Ask a PDF", translations: { he: "שאלו את ה-PDF" }, slug: "workspace/pdf-chat" },
            { label: "Vault in a folder on the phone", slug: "workspace/mobile-vault-folder" },
            { label: "JSON Canvas (Obsidian .canvas)", slug: "workspace/json-canvas", translations: { he: "JSON Canvas (‏.canvas של Obsidian)" } },
            { label: "Jewish sources (Sefaria)", slug: "workspace/jewish-sources", translations: { he: "מקורות יהודיים (ספריא)" } },
          ],
        },
        {
          label: "Collaboration",
          items: [
            { label: "Real-time WebRTC", slug: "collab/webrtc" },
            { label: "End-to-end encryption", slug: "collab/encryption" },
            { label: "Persistent rooms", slug: "collab/persistent", translations: { he: "חדרים מתמשכים" } },
          ],
        },
        {
          label: "AI",
          items: [
            { label: "Auto-tag + link suggestions", slug: "ai/agents" },
            { label: "Local LLM (web-llm)", slug: "ai/local-llm" },
            { label: "Local translation", slug: "ai/translation" },
            { label: "English spelling on this device", slug: "ai/spelling" },
            { label: "Image descriptions on this device", slug: "ai/image-captions" },
            { label: "Hebrew niqqud on this device", slug: "ai/nikud" },
            { label: "AI doctor", slug: "ai/doctor" },
            { label: "Image search by description", slug: "ai/image-search" },
            { label: "Data analyst", slug: "ai/data-analyst" },
            { label: "Train a model on your style, locally", slug: "ai/local-fine-tune" },
            { label: "AI-written text", translations: { he: "טקסט שנכתב ב-AI" }, slug: "ai/authorship" },
            { label: "Local autocomplete (FIM)", translations: { he: "השלמה אוטומטית מקומית (FIM)" }, slug: "ai/autocomplete" },
            { label: "Translation review", translations: { he: "ביקורת תרגומים" }, slug: "ai/translation-review" },
            { label: "AI cost: usage meter + answer cache", slug: "ai/cost" },
            { label: "Batch jobs: pause, resume, progress", translations: { he: "משימות אצווה: השהיה, המשך, התקדמות" }, slug: "ai/batch" },
            { label: "Research + citation checks", slug: "ai/research" },
            { label: "Local agents: tools, critic, suggestions", slug: "ai/local-agents", translations: { he: "סוכנים מקומיים: כלים, מבקר, הצעות" } },
            { label: "Agent eval: 14 agents, HTML report", slug: "ai/agent-eval", translations: { he: "הערכת סוכנים: 14 סוכנים, דוח HTML" } },
            { label: "Personal data before the cloud", slug: "ai/pii-redaction", translations: { he: "מידע אישי לפני הענן" } },
            { label: "Grounded summaries", translations: { he: "סיכומים מעוגנים" }, slug: "ai/summarize" },
            { label: "Search reranking, measured", translations: { he: "דירוג מחדש בחיפוש, במדידה" }, slug: "ai/reranker" },
            { label: "Meeting notes", translations: { he: "סיכום פגישה" }, slug: "ai/meeting-notes" },
            { label: "MCP integration (Claude Desktop, Cursor)", slug: "ai/mcp" },
            { label: "Privacy and the AI policy", slug: "ai/privacy", translations: { he: "פרטיות ומדיניות ה-AI" } },
            { label: "Cloud only by choice", translations: { he: "ענן רק בבחירה" }, slug: "ai/cloud-routes" },
          ],
        },
        {
          label: "Plugins + Templates",
          items: [
            { label: "Plugin SDK", slug: "plugins/sdk" },
            { label: "Sandbox and permissions", slug: "plugins/sandbox" },
            { label: "Plugin API", slug: "plugins/api" },
            { label: "Plugin gallery", slug: "plugins/gallery" },
            { label: "Plugin signing keys", slug: "plugins/signing" },
            { label: "Templates", slug: "plugins/templates", translations: { he: "תבניות" } },
            { label: "Web Clipper extension", slug: "plugins/web-clipper" },
          ],
        },
        {
          label: "Sync",
          items: [
            { label: "Git sync", slug: "sync/git", translations: { he: "סנכרון Git" } },
            { label: "Sync providers (WebDAV, S3, Dropbox, Drive)", slug: "sync/cloud", translations: { he: "ספקי סנכרון (WebDAV, ‏S3, ‏Dropbox, ‏Drive)" } },
            { label: "Encrypted sync (E2EE)", slug: "sync/e2ee", translations: { he: "סנכרון מוצפן (E2EE)" } },
            { label: "Read-mode publishing", slug: "sync/publish", translations: { he: "פרסום לקריאה" } },
            { label: "Publish to your own site", slug: "sync/own-site", translations: { he: "פרסום לאתר משלך" } },
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
            { label: "Monitoring and web vitals", slug: "security/monitoring", translations: { he: "ניטור ומדדי ביצועים" } },
            { label: "Vault encryption at rest", slug: "security/vault-encryption", translations: { he: "הצפנת הכספת במנוחה" } },
          ],
        },
        {
          label: "Contributing",
          translations: { he: "תרומה לפרויקט" },
          items: [
            { label: "Translation drafts", translations: { he: "טיוטות תרגום" }, slug: "contributing/translation-drafts" },
            { label: "Visual regression", translations: { he: "רגרסיה חזותית" }, slug: "contributing/visual-regression" },
            { label: "Checks on every branch (Vercel)", translations: { he: "בדיקות בכל ענף (Vercel)" }, slug: "contributing/checks" },
          ],
        },
        {
          label: "Self-hosting",
          items: [
            { label: "Docker compose bundle", slug: "self-hosting/docker" },
            { label: "Where Lumen runs", slug: "self-hosting/hosting", translations: { he: "איפה Lumen רץ" } },
            { label: "Android and iOS builds", slug: "self-hosting/mobile", translations: { he: "בניית Android ו-iOS" } },
          ],
        },
        {
          label: "Project",
          translations: { he: "הפרויקט" },
          items: [
            { label: "Issue triage", slug: "project/issue-triage", translations: { he: "מיון issues" } },
          ],
        },
        {
          label: "Project",
          translations: { he: "הפרויקט" },
          items: [
            { label: "Public roadmap", slug: "project/roadmap", translations: { he: "מפת דרכים ציבורית" } },
          ],
        },
      ],
    }),
  ],
});
