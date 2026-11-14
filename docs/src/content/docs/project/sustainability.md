---
title: Sustainability
description: How Lumen pays for itself without ads, accounts or locked features. Donations through GitHub Sponsors and Open Collective, an optional paid relay that sees only ciphertext, and every cost in the open.
---

Lumen is open source and mostly built by one person. This page is the plan for keeping it running. The live, script-free summary is the [support page](https://lumen-md.vercel.app/support.html).

## Principles

- **Every feature stays free and local.** Nothing in the app is locked behind a payment.
- **Money pays for hosting only.** The one paid product is an optional managed sync relay. Running your own relay stays free (`node sync-server/vault-relay.js`, from sync in two clicks, #483).
- **The paid relay sees no content,** the same as the free one. Notes are encrypted on the device before they leave it ([encrypted sync](/sync/e2ee/)).
- **Every cost is public.** The support page lists what Lumen pays each month, and `scripts/cost-model.mjs` computes the paid tier's numbers. A test checks that the page and the model agree.

## What it costs today

| Service | What for | Per month |
| --- | --- | --- |
| Vercel Hobby | The app at lumen-md.vercel.app | $0 |
| Cloudflare Workers, free plan | The [public live-share server](/collab/public-server/) | $0 |
| GitHub | Code, issues, releases | $0 |

**Total: $0.** Vercel's Hobby plan is for non-commercial use only. Asking for donations is allowed, but selling anything, the relay included, is commercial use under [Vercel's fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines). Before the paid relay launches, the app moves to a host that allows commercial use, or to Vercel Pro (plan W4.27).

## Donations

| Channel | Fee | Why |
| --- | --- | --- |
| [GitHub Sponsors](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors), personal account | 0% from personal sponsors. Organizations pay up to 6% (3% card processing and 3% service). | No fee, and Israel is a supported region for receiving money. |
| [Open Collective](https://opencollective.com) through [Open Source Collective](https://opencollective.com/opensource/apply/intro) | 10% host fee, plus the card processor's fee | A public ledger: every donation and every expense, with receipts. |

### Choosing a fiscal host (researched 12.11.2026)

A fiscal host holds the money, keeps the books and pays expenses for a collective that has no legal entity of its own.

| Host | Fit for Lumen | Notes |
| --- | --- | --- |
| **Open Source Collective** | **Chosen** | Hosts open-source projects. Host fee 10% ([application page](https://opencollective.com/opensource/apply/intro)). Verification through GitHub, or manual review. |
| Open Collective Europe | No | For projects rooted in or connected to Europe ([Open Collective's list of hosting options](https://blog.opencollective.com/fiscal-hosting-options)). |
| Open Collective Foundation | No | Dissolved on 31.12.2024 ([announcement](https://blog.opencollective.com/open-collective-official-statement-ocf-dissolution/)). |
| Huddlecraft | No | UK-based projects or projects in GBP. 4.25% plus a £50 setup fee. |
| The Social Change Nest | Possible | A UK CIC that can host groups outside the UK. It hosts social causes, not specifically software. |

Payouts from Open Source Collective reach an Israeli bank account through Wise or PayPal. Their fees depend on the currency and the country ([payment processor fees](https://documentation.opencollective.com/expenses-and-getting-paid/payment-processor-fees)).

## The paid relay (optional, planned)

### What it is

The same blob protocol as the relay of sync in two clicks (`sync-server/vault-relay.js`, #483), run by Lumen for people who don't want to run their own. The app talks to it exactly as it talks to a self-hosted relay. The only difference is `VITE_SYNC_RELAY_URL`. There are no accounts in the app.

### Where it runs

On the Cloudflare account that already runs the public live-share server (#469, `edge-workers/collab/`), as a second Worker:

- **R2** holds the objects. Each key is the SHA-256 of the space plus the object name, which is already an HMAC chosen by the app.
- **One Durable Object per space** makes `If-Match` / `If-None-Match` writes atomic and keeps the object list, the ETags and the byte count in its SQLite storage. The relay's store interface (`createVaultRelay({ store })`) is the seam: an R2 store plus a per-space Durable Object lock implement the same `list / get / put / delete / bytes / sweep` methods that the tests already check.
- Limits: 10 GB per paid space, 25 MiB per object, and the same rate limit as the Node relay. Request logging stays off, as for #469.

### What it sees

| | The paid relay |
| --- | --- |
| Note text, titles, file names | **Never.** The device encrypts everything, and object names are HMACs. |
| Your key or recovery words | **Never.** The space is named by a token derived from the words (#483). The relay keeps only the token's SHA-256. |
| Sizes and times of encrypted objects | Yes |
| Who paid | No. That stays with the payment provider. The relay keeps only a keyed hash of the licence, tied to one space (see below). |

### Paying without an account

1. Phase 1: a **licence key** from the merchant of record (Polar issues licence keys with each purchase). The app sends it once, together with the space token. The Worker checks it against the provider's API and stores `HMAC(secret, licence id) → (space hash, plan, expiry)`. The provider knows who paid but never learns the space. The relay knows the space but not who paid. The two can be linked only by combining both records.
2. Phase 2: **unlinkable tokens**, with blind signatures (RSA blind signatures, RFC 9474, as used in Privacy Pass). The payment issues blinded tokens and the relay redeems them, so not even the combined records connect a payer to a space.
3. When a subscription ends, the space becomes read-only for 30 days and is deleted after 90 days. Every device still has the notes. Free self-hosting stays one command away.

## Cost per user and break-even

From `node scripts/cost-model.mjs`, with list prices checked on 12.11.2026: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) and [Polar](https://polar.sh/docs/fees). The usage assumption is an active note-taker with 2–3 devices: 1 GB encrypted, about 100 writes and 1,000 reads a day.

| Per paying user per month | USD |
| --- | --- |
| R2 storage (1 GB) | $0.0150 |
| R2 writes (3,000) | $0.0135 |
| R2 reads (30,000) | $0.0108 |
| Worker requests | $0.0099 |
| Durable Object requests | $0.0005 |
| **Infrastructure total** | **$0.0496** |

| | Monthly plan, $3 | Yearly plan, $30 |
| --- | --- | --- |
| Payment fee per payment (Polar Starter, 5% + $0.50, +1.5% for a non-US card) | $0.6950 | $2.45 |
| Left per subscriber per month | $2.26 | $2.25 |

| Fixed per month | USD | Break-even |
| --- | --- | --- |
| Workers Paid ($5) + a domain (about $10.44 a year), app on a free host | $5.87 | **3 subscribers** |
| The same, app on Vercel Pro ($20) | $25.87 | **12 subscribers** |

The model does not count the owner's time or an accountant's fee. Those depend on the owner's choices (see below). Storage dominates only for very large vaults: at the 10 GB cap, a user costs about $0.18 a month.

## Taking payments

| Option | For an Israeli seller | Verdict |
| --- | --- | --- |
| **Polar** (merchant of record) | Pays out to Israel through Stripe Connect Express ([supported countries](https://polar.sh/docs/merchant-of-record/supported-countries)). Starter: 5% + $0.50, +1.5% for cards outside the US. Licence keys built in. Its code is open source. | **Chosen** |
| Paddle (merchant of record) | 5% + $0.50. Mature, aimed at software companies, with a review before selling. | Fallback |
| Lemon Squeezy (merchant of record) | 5% + $0.50. Now owned by Stripe and moving to Stripe Managed Payments, which supports merchants in 35+ countries ([2026 update](https://www.lemonsqueezy.com/blog/2026-update)). Israel is not confirmed. | Not now |
| Stripe directly | Israel is not on [Stripe's list of supported countries](https://stripe.com/global). It would need a US company (Stripe Atlas), and Lumen would have to collect and remit VAT and sales tax worldwide itself. | Rejected |

A merchant of record is the legal seller to each subscriber. It charges and remits the subscriber's VAT or sales tax in the subscriber's country, handles refunds and chargebacks, and pays the developer. With one, Lumen sells to one foreign company instead of to people in many tax systems.

### Israeli VAT and income tax (for the owner and an accountant)

- **Osek patur (exempt dealer).** No VAT is charged. Turnover must stay under the yearly ceiling: ₪122,833 in 2026, counting all of the business's turnover. This is the simplest start.
- **Osek murshe (licensed dealer).** A service given to a foreign resident, such as the merchant of record, can be zero-rated under section 30(a)(5) of the VAT Law. The section excludes a service that is in practice also given to an Israeli resident in Israel. The VAT Authority could read Israeli subscribers as that case and expect 18% on their share. Get a ruling, or report 18% on the payouts for Israeli customers. The provider's reports show each customer's country.
- **Donations** through Open Source Collective are paid out against expenses or invoices. Payouts from GitHub Sponsors are income too. GitHub asks a non-US recipient for a W-8BEN.
- This is a plan, not tax advice. An Israeli accountant (רואה חשבון) confirms it before the first sale.

## Owner steps

1. **GitHub Sponsors.** Enroll the personal account at github.com/sponsors: payout profile, W-8BEN, and tiers (for example $3, $10, $25). Then uncomment `github:` in `.github/FUNDING.yml`.
2. **Open Collective.** Create the collective `lumen-md` and apply to Open Source Collective (verify through GitHub). Once it is accepted, uncomment `open_collective:` in `.github/FUNDING.yml`.
3. **Accountant.** Choose between osek patur and osek murshe, get the section 30(a)(5) question answered for a merchant of record, and set up bookkeeping.
4. **Hosting (W4.27).** Before the first sale, move the app off Vercel Hobby, to a host that allows commercial use or to Vercel Pro.
5. **Polar.** Create the organisation and one product, "Lumen sync relay", at $3 a month or $30 a year, with licence keys. Connect the payout account (Stripe Connect Express, Israel). The Polar API token becomes a Worker secret.
6. **Cloudflare.** Turn on Workers Paid ($5), create the R2 bucket, and deploy the vault relay Worker (a follow-up to this plan; the code seam is described above).
7. **Privacy policy and terms.** Update the privacy policy (#456) for what the provider and the relay keep, and add short terms for the paid relay.
8. **Every month.** Update the support page's cost table and the cost model's prices from the real invoices, and post the same numbers on Open Collective.
