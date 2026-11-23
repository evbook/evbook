import { secureHeaders } from "hono/secure-headers";

/**
 * The hash of the one inline script in `app/index.html`, the theme resolved
 * before first paint. `securityHeaders.test.ts` fails when the script changes
 * and this does not.
 */
export const THEME_SCRIPT_HASH = "'sha256-8ylCZ7WTQOulbf1lOLwYPZudXZlkI9aF1Lk18PYOcBY='";

/**
 * The headers every response carries. Two places send them and must agree:
 * this middleware, for everything that passes the app (the API on both
 * runtimes, and the SPA too on Node), and `app/public/_headers`, for the SPA
 * on Cloudflare, where Workers Assets serves it without running the Worker.
 * `securityHeaders.test.ts` compares the two.
 *
 * - Framing is refused twice: `X-Frame-Options` for older browsers, and
 *   `frame-ancestors`, which a report-only policy cannot enforce, as its own
 *   enforced policy.
 * - `strict-origin-when-cross-origin` rather than `same-origin`: the map
 *   tiles come from tile.openstreetmap.org, whose usage policy asks web pages
 *   to send a Referer and forbids a policy that suppresses it. Another origin
 *   sees the instance's origin and never a page's path.
 * - The full Content-Security-Policy is report-only for now: the browser
 *   console names what it would block, and the map tile hosts and inline
 *   styles it needs can be confirmed before it is enforced.
 * - Hono's other defaults are off on purpose: HSTS belongs to whoever
 *   terminates TLS, and the cross-origin isolation headers change behaviour
 *   that nothing here has been tested against.
 */
export const securityHeaders = secureHeaders({
  xFrameOptions: "DENY",
  xContentTypeOptions: true,
  referrerPolicy: "strict-origin-when-cross-origin",
  contentSecurityPolicy: { frameAncestors: ["'none'"] },
  contentSecurityPolicyReportOnly: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", THEME_SCRIPT_HASH],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    manifestSrc: ["'self'"],
    workerSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: false,
  xDnsPrefetchControl: false,
  xDownloadOptions: false,
  xPermittedCrossDomainPolicies: false,
  xXssProtection: false,
  removePoweredBy: true,
});
