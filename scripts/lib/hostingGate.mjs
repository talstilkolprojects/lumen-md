/**
 * Plan W6.9: no first payment while production is on a non-commercial plan.
 *
 * deploy/hosting.json says which host serves production and whether its plan
 * allows commercial use (Vercel Hobby does not). A build is commercial when
 * any variable of `commercialEnv` is set to a real value: the checkout and
 * entitlement endpoints and prices of src/billing/, or LUMEN_COMMERCIAL=1
 * (the paid relay of plan W5.25 sets it). Pure.
 */

/** Placeholder values from .env.example and the docs do not count. */
const isReal = (v) => !!v && !/^(0|false|no)$/i.test(v.trim()) && !/example\.(com|org|net)|your-|placeholder/i.test(v);

/** The host this build runs on: Vercel sets VERCEL=1; scripts/pages-deploy.sh passes --host cloudflare-pages. */
export function currentHost(env, argv = []) {
  const at = argv.indexOf("--host");
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  if (env.VERCEL === "1") return "vercel";
  if (env.CF_PAGES === "1") return "cloudflare-pages";
  return null;
}

/**
 * → { ok, host, commercialVars, problems: string[] }
 * A build on a host whose plan is not commercial, with commercial variables
 * set, fails; so does a hosting.json whose production host is not commercial
 * while those variables are set anywhere (the release check, run off-host).
 */
export function hostingGate(hosting, env, argv = []) {
  const vars = (hosting.commercialEnv ?? []).filter((k) => isReal(env[k]));
  const host = currentHost(env, argv);
  const problems = [];
  if (!hosting.hosts?.[hosting.production]) problems.push(`deploy/hosting.json: production host "${hosting.production}" is not under hosts`);
  if (host && !hosting.hosts?.[host]) problems.push(`deploy/hosting.json: this build's host "${host}" is not under hosts`);
  if (vars.length) {
    const here = host ? hosting.hosts?.[host] : null;
    if (here && !here.commercial)
      problems.push(`${host} (${here.plan}) does not allow commercial use, and this build takes payments (${vars.join(", ")}): ${here.why}`);
    const prod = hosting.hosts?.[hosting.production];
    if (prod && !prod.commercial)
      problems.push(
        `production is on ${hosting.production} (${prod.plan}), which does not allow commercial use: move production first (docs self-hosting/cut-over) or upgrade the plan, then update deploy/hosting.json`,
      );
  }
  return { ok: problems.length === 0, host, commercialVars: vars, problems };
}
