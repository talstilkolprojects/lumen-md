# Invitation: build a first Lumen plugin (half an hour)

**Subject:** A small ask: build a Lumen plugin and tell me where you got stuck

Hi [name],

I'm Tal, and I build Lumen: a local-first, Hebrew-first, open-source Markdown editor (https://github.com/talstilkol/lumen-md). Notes stay on the device, and the app works offline.

Lumen now has a sandboxed plugin system (QuickJS): a plugin has no network and no page access, only Lumen's API, and only the permissions the user granted. To find out whether it is really pleasant to build for, I'm looking for five developers outside the project to build one plugin each.

**What I'm asking:**
- Build one small plugin with `create-lumen-plugin`. The goal is a first plugin running within half an hour.
- Note the time at four marks (a ready form is attached).
- Tell me what slowed you down or confused you. Every problem becomes a task on our side.

**What you need:** Node.js 18 or newer. No `npm install`: the template has no dependencies.

```bash
git clone https://github.com/talstilkol/lumen-md
node lumen-md/packages/create-lumen-plugin/bin.js my-plugin
cd my-plugin && npm run dev
```

Then in Lumen (https://lumen-md.vercel.app): Plugin gallery → Developer mode → Connect.

**Ideas, if you have none:** reading time for a note, Hebrew ↔ Gregorian date conversion, a code block that draws a timeline, a cleaner for text pasted from Word, a list of a note's broken links.

**What you get:** your name on the plugin's card in the registry, thanks in the README, and a reply to your PR within 3 days.

If it suits you, just reply "yes" with your idea. If not, thanks for reading.

Tal
