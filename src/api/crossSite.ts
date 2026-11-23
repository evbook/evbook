import type { MiddlewareHandler } from "hono";

/** Methods that only read: a cross-site page may cause them, they change nothing. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses a request that changes something when the browser says it came from
 * another origin. `SameSite=Lax` keeps the session cookie off requests from
 * other sites, but a page on a sibling subdomain is the same site and could
 * otherwise post to this API with the owner's session, for instance
 * `POST /api/v1/version/update`, which needs no body. On `workers.dev` that is
 * another Worker on the same account: `workers.dev` is on the Public Suffix
 * List, so `<account>.workers.dev` is the site, and Workers of other accounts
 * are cross-site already.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by a page. It
 * compares the page with the URL the browser asked for, so it reads
 * `same-origin` behind a reverse proxy as well, where an `Origin` check against
 * the request URL would see the proxy's internal address instead.
 *
 * A request without the header is let through: every current browser sends
 * it, so it comes from a script or `curl`, which carries no one else's cookie
 * and is the integration surface docs/api.md describes.
 */
export const rejectCrossSiteWrites: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  if (site === undefined || site === "same-origin") return next();
  return c.json({ error: "cross_site_request" }, 403);
};
