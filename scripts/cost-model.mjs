#!/usr/bin/env node
/**
 * Lumen's cost model (plan W5.25): what the optional paid encrypted sync
 * relay costs per user, and how many subscribers cover the fixed costs.
 * public/support.html and docs/…/project/sustainability.md quote these
 * numbers; src/__tests__/sustainability.test.ts checks they still match.
 *
 *   node scripts/cost-model.mjs          # the table
 *   node scripts/cost-model.mjs --json   # the same, as JSON
 *
 * Prices are list prices in USD, checked on 12.11.2026 (sources in the
 * docs page). Usage per user is an assumption, stated below; change it here
 * and the page and docs must follow (the test says where).
 */

/** Provider list prices (USD). */
export const PRICES = {
  /** Cloudflare Workers Paid: $5/month minimum; 10M requests and 30M CPU-ms included. */
  workersPaidMonthly: 5,
  workersRequestPerMillion: 0.3,
  /** Durable Objects (one per sync space, for conditional writes): $0.15 per million requests past 1M. */
  doRequestPerMillion: 0.15,
  /** R2 Standard: storage per GB-month, Class A (writes) and Class B (reads) per million. Egress free. */
  r2StoragePerGbMonth: 0.015,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  /** Polar (merchant of record), Starter plan: 5% + $0.50 per transaction, +1.5% for cards outside the US. */
  morPercent: 0.05,
  morFixed: 0.5,
  morInternationalPercent: 0.015,
  /** App hosting once anything is sold: Vercel Hobby is non-commercial only. Cloudflare Pages: $0; Vercel Pro: $20. */
  hostingCloudflarePages: 0,
  hostingVercelPro: 20,
  /** An own domain for the relay (optional; workers.dev is free): about $10.44/year at Cloudflare Registrar for .com. */
  domainYearly: 10.44,
};

/** What one paying user does in a month (assumption: an active note-taker syncing 2–3 devices). */
export const USAGE = {
  /** Average encrypted vault stored on the relay, GB (the paid quota is 10 GB). */
  storedGb: 1,
  /** Object writes (PUT): about 100 a day. */
  writes: 3000,
  /** Object reads and listings (GET): about 1,000 a day across devices. */
  reads: 30000,
};

/** The two prices offered (USD): monthly, and yearly at ten months. */
export const PLANS = { monthly: 3, yearly: 30 };

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Marginal infrastructure cost of one paying user per month (USD). */
export function perUserMonthly(p = PRICES, u = USAGE) {
  const requests = u.writes + u.reads;
  const parts = {
    storage: u.storedGb * p.r2StoragePerGbMonth,
    writes: (u.writes / 1e6) * p.r2ClassAPerMillion,
    reads: (u.reads / 1e6) * p.r2ClassBPerMillion,
    worker: (requests / 1e6) * p.workersRequestPerMillion,
    durableObject: (u.writes / 1e6) * p.doRequestPerMillion,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)])), total: round(total) };
}

/** What the merchant of record keeps from one payment (worst case: a card outside the US). */
export function morFee(price, p = PRICES) {
  return round(price * (p.morPercent + p.morInternationalPercent) + p.morFixed);
}

/** Net per subscriber per month, for each plan. */
export function netMonthly(p = PRICES, u = USAGE, plans = PLANS) {
  const infra = perUserMonthly(p, u).total;
  return {
    monthly: round(plans.monthly - morFee(plans.monthly, p) - infra),
    yearly: round((plans.yearly - morFee(plans.yearly, p)) / 12 - infra),
  };
}

/** Fixed monthly costs, with the app on Cloudflare Pages (cheapest) or on Vercel Pro. */
export function fixedMonthly(p = PRICES) {
  const base = p.workersPaidMonthly + p.domainYearly / 12;
  return { cloudflarePages: round(base + p.hostingCloudflarePages, 2), vercelPro: round(base + p.hostingVercelPro, 2) };
}

/** Subscribers needed to cover the fixed costs (the worse of the two plans' net). */
export function breakEven(p = PRICES, u = USAGE, plans = PLANS) {
  const net = Math.min(...Object.values(netMonthly(p, u, plans)));
  const fixed = fixedMonthly(p);
  return { cloudflarePages: Math.ceil(fixed.cloudflarePages / net), vercelPro: Math.ceil(fixed.vercelPro / net) };
}

export function model() {
  return { prices: PRICES, usage: USAGE, plans: PLANS, perUser: perUserMonthly(), morFee: { monthly: morFee(PLANS.monthly), yearly: morFee(PLANS.yearly) }, net: netMonthly(), fixed: fixedMonthly(), breakEven: breakEven() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = model();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    const usd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
    console.log("Infrastructure per paying user per month:");
    for (const [k, v] of Object.entries(m.perUser.parts)) console.log(`  ${k.padEnd(14)} ${usd(v)}`);
    console.log(`  ${"total".padEnd(14)} ${usd(m.perUser.total)}`);
    console.log(`Merchant-of-record fee per payment: monthly ${usd(m.morFee.monthly)}, yearly ${usd(m.morFee.yearly)}`);
    console.log(`Net per subscriber per month: monthly plan ${usd(m.net.monthly)}, yearly plan ${usd(m.net.yearly)}`);
    console.log(`Fixed per month: ${usd(m.fixed.cloudflarePages)} (app on Cloudflare Pages), ${usd(m.fixed.vercelPro)} (app on Vercel Pro)`);
    console.log(`Break-even: ${m.breakEven.cloudflarePages} subscribers (Cloudflare Pages), ${m.breakEven.vercelPro} (Vercel Pro)`);
  }
}
