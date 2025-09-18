import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// Configure allowed origins via SHOP_DOMAIN env var (comma-separated)
const allowed = (process.env.SHOP_DOMAIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// CORS middleware that allows either all (if none specified) or only allowed origins
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowed.length === 0) return callback(null, true);
      if (allowed.indexOf(origin) !== -1) return callback(null, true);
      return callback(
        new Error("CORS not allowed for origin: " + origin),
        false
      );
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

let fetchFn;
if (typeof globalThis.fetch === "function") fetchFn = globalThis.fetch;
else {
  const mod = await import("node-fetch");
  fetchFn = mod.default;
}
const NIVODA_API = process.env.NIVODA_API; // staging or production endpoint
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
let SHOP_DOMAIN = (process.env.SHOP_DOMAIN || "").replace(/\/$/, ""); // normalize
const MAP_BASE_URL = process.env.MAP_BASE_URL || "";
const USE_BASIC_AUTH =
  (process.env.USE_BASIC_AUTH || "false").toLowerCase() === "true";

if (!NIVODA_API || !NIVODA_USER || !NIVODA_PASS) {
  console.warn(
    "WARNING: Missing NIVODA_API / NIVODA_USER / NIVODA_PASS in env"
  );
}

// Token caching for authenticate flow
let cachedToken = null;
let tokenExpiry = 0;

async function authenticateAndGetToken() {
  // only used when USE_BASIC_AUTH === false
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
  if (!token) throw new Error("Auth failed. Raw: " + text);
  cachedToken = token;
  tokenExpiry = now + 1000 * 60 * 60 * 5.5;
  return token;
}

// Send GraphQL query to Nivoda with correct header strategy
async function postGraphQL(query) {
  if (USE_BASIC_AUTH) {
    // Basic auth header: base64(username:password)
    const basic = Buffer.from(`${NIVODA_USER}:${NIVODA_PASS}`).toString(
      "base64"
    );
    return fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ query }),
    });
  } else {
    // token flow
    const token = await authenticateAndGetToken();
    return fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
  }
}

/* Basic endpoints */
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug-auth", async (req, res) => {
  try {
    if (USE_BASIC_AUTH) {
      // show that Basic auth is configured (don't reveal password)
      return res.json({ ok: true, auth: "basic", user: NIVODA_USER });
    } else {
      const token = await authenticateAndGetToken();
      return res.json({
        ok: true,
        auth: "token",
        token_sample: token.slice(0, 20) + "...",
      });
    }
  } catch (err) {
    console.error("debug-auth error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Helper: attempt query by certificate_numbers (array)
async function queryByCertificate(cert) {
  const diamondQuery = `
    query {
      diamonds_by_query(
        query: { certificate_numbers: ["${cert}"] },
        limit: 1
      ) {
        total_count
        items {
          id
          diamond {
            id
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
  const r = await postGraphQL(diamondQuery);
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { parseError: true, raw: text };
  }
  return { status: r.status, json, rawText: text };
}

// GET /search?certificate=...
app.get("/search", async (req, res) => {
  try {
    // CORS: allow only configured SHOP_DOMAIN if set
    const origin = req.headers.origin || "";
    if (SHOP_DOMAIN && origin && origin !== SHOP_DOMAIN) {
      return res.status(403).json({ error: "Forbidden origin" });
    }
    res.setHeader("Access-Control-Allow-Origin", SHOP_DOMAIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");

    const cert = (req.query.certificate || "").trim();
    if (!cert)
      return res
        .status(400)
        .json({ error: "certificate query param required" });

    // try normalized variants (quick)
    const variants = Array.from(
      new Set([
        cert,
        cert.toUpperCase(),
        cert.replace(/\s+/g, ""),
        cert.replace(/[^0-9A-Za-z]+/g, ""),
        cert.replace(/^0+/, ""),
      ])
    ).filter(Boolean);

    const attempts = [];
    for (const v of variants) {
      const { status, json } = await queryByCertificate(v);
      const total = json?.data?.diamonds_by_query?.total_count ?? 0;
      attempts.push({ variant: v, status, total, raw: json });
      if (total && total > 0) {
        const item = json.data.diamonds_by_query.items[0];
        const certNumber = item.diamond?.certificate?.certNumber || "";
        const redirectUrl = MAP_BASE_URL
          ? MAP_BASE_URL + encodeURIComponent(certNumber || item.id)
          : null;
        return res.json({
          found: true,
          variantMatched: v,
          redirectUrl,
          item,
          attempts,
        });
      }
    }

    return res.json({ found: false, attempts });
  } catch (err) {
    console.error("search error", err);
    return res.status(500).json({ error: err.message || "server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(
    `Nivoda proxy listening on ${PORT} (USE_BASIC_AUTH=${USE_BASIC_AUTH})`
  )
);
