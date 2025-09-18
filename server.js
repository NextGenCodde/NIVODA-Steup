// server.js - Nivoda proxy + Shopify product lookup (Storefront API)
// Replace your current server.js with this file
import express from "express";
import dotenv from "dotenv";
dotenv.config();

let fetchFn;
if (typeof globalThis.fetch === "function") fetchFn = globalThis.fetch;
else {
  const mod = await import("node-fetch");
  fetchFn = mod.default;
}

import cors from "cors";

const app = express();
app.use(express.json());

// Basic CORS config - allow origins in SHOP_DOMAIN (comma-separated) or all if not set
const allowed = (process.env.SHOP_DOMAIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (!allowed.length) return callback(null, true);
      if (allowed.indexOf(origin) !== -1) return callback(null, true);
      callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const NIVODA_API = process.env.NIVODA_API;
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
const USE_BASIC_AUTH =
  (process.env.USE_BASIC_AUTH || "false").toLowerCase() === "true";
const MAP_BASE_URL = process.env.MAP_BASE_URL || "";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

if (!NIVODA_API || !NIVODA_USER || !NIVODA_PASS) {
  console.warn("Missing NIVODA_API / NIVODA_USER / NIVODA_PASS");
}

// Token cache for Nivoda (for token auth flow)
let cachedToken = null;
let tokenExpiry = 0;

async function authenticateAndGetToken() {
  // Don't try authenticate if we are required to use Basic-only (but we still allow fallback)
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const authQuery = `{
    authenticate {
      username_and_password(username: "${NIVODA_USER}", password: "${NIVODA_PASS}") {
        token
      }
    }
  }`;

  const r = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: authQuery }),
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("Auth response not JSON: " + text);
  }
  const token = json?.data?.authenticate?.username_and_password?.token;
  if (!token) throw new Error("Nivoda auth failed: " + text);
  cachedToken = token;
  tokenExpiry = now + 1000 * 60 * 60 * 5.5;
  return token;
}

// Try GraphQL with Basic auth, return { status, ok, text, json }
async function tryPostWithBasic(query) {
  const basic = Buffer.from(`${NIVODA_USER}:${NIVODA_PASS}`).toString("base64");
  try {
    const r = await fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
    return { status: r.status, ok: r.ok, text, json };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      text: (err && err.message) || "basic fetch error",
      json: null,
    };
  }
}

// Try GraphQL with Bearer token, return { status, ok, text, json }
async function tryPostWithBearer(query) {
  try {
    const token = await authenticateAndGetToken();
    const r = await fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
    return { status: r.status, ok: r.ok, text, json };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      text: (err && err.message) || "bearer fetch error",
      json: null,
    };
  }
}

/**
 * Unified call: if USE_BASIC_AUTH true, try Basic first.
 * If Basic yields obvious auth-error (NO_USER / Authorization Header Invalid) or non-OK,
 * fallback to Bearer token-based auth automatically.
 * Returns: { status, ok, text, json, usedAuth: 'basic'|'bearer' }
 */
async function postGraphQLToNivoda(query) {
  if (USE_BASIC_AUTH) {
    const basicRes = await tryPostWithBasic(query);
    const errs = (basicRes.json && basicRes.json.errors) || [];
    const errMsgs = errs.map((e) => (e && e.message) || "").join(" | ");
    const hasAuthProblem =
      /NO_USER|Authorization Header Invalid|401|401 Unauthorized|Unauthorized/i.test(
        basicRes.text + " " + errMsgs
      );

    if (basicRes.ok && !hasAuthProblem) {
      return { ...basicRes, usedAuth: "basic" };
    }
    // log and fall back
    console.warn(
      "[NIVODA] Basic auth failed or rejected, falling back to token. basicRes.status=",
      basicRes.status,
      "msgs=",
      errMsgs || basicRes.text
    );
    // fallthrough to bearer
  }

  // Try bearer/token
  const bearerRes = await tryPostWithBearer(query);
  if (bearerRes.ok) {
    return { ...bearerRes, usedAuth: "bearer" };
  }

  // both failed; return bearerRes (or basicRes if you want). We'll prefer the more informative one.
  return { ...bearerRes, usedAuth: "bearer" };
}

/**
 * Search Shopify Storefront API for a product that matches the certificate.
 * Returns product URL or null.
 */
async function findShopifyProduct(cert) {
  if (!SHOPIFY_STORE || !SHOPIFY_STOREFRONT_TOKEN) return null;

  const storefrontUrl = `https://${SHOPIFY_STORE}/api/2024-07/graphql.json`;
  const graphql = `
    query search($q: String!) {
      products(first: 1, query: $q) {
        edges {
          node {
            handle
            title
          }
        }
      }
    }
  `;
  const body = { query: graphql, variables: { q: cert } };

  try {
    const res = await fetchFn(storefrontUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return null;
    }
    const edges = json?.data?.products?.edges || [];
    if (edges.length > 0) {
      const handle = edges[0].node.handle;
      return `https://${SHOPIFY_STORE}/products/${handle}`;
    }
    return null;
  } catch (err) {
    console.warn("[SHOPIFY] storefront lookup failed", err && err.message);
    return null;
  }
}

/**
 * Try Nivoda for each variant and return first match.
 * Returns { found: boolean, variantMatched, item, attempts }
 * attempts is a list of { variant, status, total, raw }
 */
async function queryNivodaForCertificateVariants(variants) {
  const attempts = [];
  for (const v of variants) {
    const diamondQuery = `
      query {
        diamonds_by_query(
          query: { certificate_numbers: ["${v}"] },
          limit: 1
        ) {
          total_count
          items {
            id
            diamond {
              id
              supplierStockId
              image
              certificate {
                certNumber
                lab
                shape
                carats
              }
            }
            price
          }
        }
      }
    `;
    const r = await postGraphQLToNivoda(diamondQuery);
    const json = r.json || null;
    const total = json?.data?.diamonds_by_query?.total_count ?? 0;
    attempts.push({
      variant: v,
      status: r.status,
      total,
      raw: json,
      usedAuth: r.usedAuth,
      rawText: r.text,
    });

    const items = json?.data?.diamonds_by_query?.items || [];
    if (items.length > 0) {
      return { found: true, variantMatched: v, item: items[0], attempts };
    }
  }
  return { found: false, attempts };
}

function makeVariants(cert) {
  if (!cert) return [];
  const v = [];
  v.push(cert);
  v.push(cert.toUpperCase());
  v.push(cert.replace(/\s+/g, ""));
  v.push(cert.replace(/[^0-9A-Za-z]+/g, ""));
  v.push(cert.replace(/^0+/, ""));
  v.push(cert.toUpperCase().replace(/\s+/g, ""));
  return Array.from(new Set(v)).filter(Boolean);
}

// health / debug
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug-auth", async (req, res) => {
  try {
    // Try both methods and report what works (non-destructive)
    const info = {
      configuredUseBasic: USE_BASIC_AUTH,
      nivodaApi: NIVODA_API,
      tryBasic: null,
      tryToken: null,
    };
    // try a tiny authenticate query with basic (if configured)
    const testQuery =
      '{ authenticate { username_and_password(username: "' +
      NIVODA_USER +
      '", password: "' +
      NIVODA_PASS +
      '") { token } } }';
    if (USE_BASIC_AUTH) {
      const basicAttempt = await tryPostWithBasic(testQuery);
      info.tryBasic = {
        status: basicAttempt.status,
        ok: basicAttempt.ok,
        errors: (basicAttempt.json && basicAttempt.json.errors) || null,
        textSample: (basicAttempt.text || "").slice(0, 300),
      };
    }
    // try token flow
    try {
      const token = await authenticateAndGetToken();
      info.tryToken = { ok: true, token_sample: token.slice(0, 20) + "..." };
    } catch (err) {
      info.tryToken = { ok: false, error: err.message };
    }
    return res.json({ ok: true, info });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err.message || String(err) });
  }
});

// main search endpoint
app.get("/search", async (req, res) => {
  try {
    const certRaw = (req.query.certificate || "").trim();
    if (!certRaw)
      return res
        .status(400)
        .json({ error: "certificate query param required" });

    const variants = makeVariants(certRaw);

    const nivodaResult = await queryNivodaForCertificateVariants(variants);

    if (!nivodaResult.found) {
      return res.json({ found: false, attempts: nivodaResult.attempts });
    }

    const item = nivodaResult.item;
    const certNumber = item.diamond?.certificate?.certNumber || variants[0];

    // Try to find Shopify product
    const productUrl = await findShopifyProduct(certNumber);
    const redirectUrl =
      productUrl ||
      (MAP_BASE_URL ? MAP_BASE_URL + encodeURIComponent(certNumber) : null);

    return res.json({
      found: true,
      variantMatched: nivodaResult.variantMatched,
      redirectUrl,
      item,
      attempts: nivodaResult.attempts,
    });
  } catch (err) {
    console.error("search error", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err.message || "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(
    `Nivoda proxy listening on ${PORT} (USE_BASIC_AUTH=${USE_BASIC_AUTH})`
  )
);
