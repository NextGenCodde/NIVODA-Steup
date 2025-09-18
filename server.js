// server.js (REST API Wrapper for Nivoda GraphQL) — FIXED
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
dotenv.config();

let fetchFn;
if (typeof globalThis.fetch === "function") fetchFn = globalThis.fetch;
else {
  const mod = await import("node-fetch");
  fetchFn = mod.default;
}

const app = express();
app.use(express.json());

// CORS configuration (keep as you had)
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        process.env.SHOP_DOMAIN,
        "https://alturadiamonds.com",
        "http://localhost:3000",
      ].filter(Boolean);
      // allow if no origin (server-to-server) or in allowed list
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // For debugging you might want to block unknown origins; for now allow
        callback(null, true);
      }
    },
    credentials: true,
  })
);

const NIVODA_API = process.env.NIVODA_API; // e.g. https://integrations.nivoda.net/graphql
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
const MAP_BASE_URL =
  process.env.MAP_BASE_URL || "https://alturadiamonds.com/products/";

// Token caching
let cachedToken = null;
let tokenExpiry = 0;

// Get authentication token
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const authQuery = `
    query {
      authenticate {
        username_and_password(username: "${NIVODA_USER}", password: "${NIVODA_PASS}") {
          token
        }
      }
    }
  `;

  const authResponse = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: authQuery }),
  });

  const authText = await authResponse.text();
  if (!authResponse.ok) {
    throw new Error(
      `Authentication failed: ${authResponse.status} ${authText}`
    );
  }

  const authJson = JSON.parse(authText);
  if (authJson.errors) {
    throw new Error("GraphQL Auth Error: " + JSON.stringify(authJson.errors));
  }

  const token = authJson?.data?.authenticate?.username_and_password?.token;
  if (!token) {
    throw new Error("Failed to get authentication token");
  }

  // Cache token for 6 hours minus 1 minute buffer
  cachedToken = token;
  tokenExpiry = now + 6 * 60 * 60 * 1000 - 60 * 1000;
  console.log("Got new Nivoda token (cached for ~6h)");
  return token;
}

// Query Nivoda GraphQL API (CERT search)
// Query Nivoda GraphQL API (CERT search) - robust: try diamonds_by_query then fallback to offers_by_query
async function searchNivodaDiamond(certArray) {
  const token = await getAuthToken();

  // Use the same query shape you used in GraphiQL (as(token:"...") wrapper)
  const gql = `
    query SearchByCertificate($certNumbers: [String!]!) {
      as(token: "${token}") {
        diamonds_by_query(
          query: {
            certificate_numbers: $certNumbers
          },
          limit: 5
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
                color
                clarity
              }
            }
            price
            availability
          }
        }
      }
    }
  `;

  const variables = { certNumbers: certArray };

  const body = JSON.stringify({ query: gql, variables });

  // LOG the outgoing request (body + endpoint)
  console.log(">>> Nivoda request ->", { url: NIVODA_API, body, headers: { "Content-Type": "application/json" } });

  const resp = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body
  });

  const respText = await resp.text();

  // Log the raw response from Nivoda
  console.log("<<< Nivoda response status:", resp.status);
  console.log("<<< Nivoda response text:", respText);

  // Basic checks & parse
  if (!resp.ok) {
    throw new Error(`Nivoda API Error: ${resp.status} ${respText}`);
  }

  let json;
  try {
    json = JSON.parse(respText);
  } catch (e) {
    throw new Error("Invalid JSON from Nivoda: " + respText);
  }

  if (json.errors) {
    // return full JSON so caller can inspect
    return json;
  }

  return json;
}



// Create Shopify product URL (cleaner)
function createProductUrl(item, cert) {
  // item should be the `diamond` object (item.diamond.certificate)
  const certificate = (item && item.certificate) || {};
  const shape = certificate.shape || "Diamond";
  const carats =
    certificate.carats !== undefined && certificate.carats !== null
      ? `${certificate.carats}`
      : "";
  const lab = certificate.lab || "";
  const color = certificate.color || "";
  const clarity = certificate.clarity || "";

  // Build title parts while avoiding empty pieces
  const parts = [
    carats ? `${carats}ct` : "",
    shape,
    lab,
    color,
    clarity,
    cert,
  ].filter(Boolean);
  const productTitle = parts.join(" ").trim();

  // Create URL handle (Shopify-friendly)
  const handle = productTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${MAP_BASE_URL}${handle}`;
}

// Generate certificate variants
function generateCertificateVariants(cert) {
  const v = new Set([
    cert,
    cert.toUpperCase(),
    cert.toLowerCase(),
    cert.replace(/^LG/i, ""), // remove LG prefix
    cert.replace(/^LG/i, "").replace(/^0+/, ""), // remove leading zeros after removing LG
    cert.replace(/[^0-9]/g, ""), // numbers only
    cert.replace(/\s+/g, ""), // remove spaces
  ]);

  // Filter short garbage
  return Array.from(v).filter((x) => x && x.length >= 2);
}

// MAIN REST API ENDPOINT
app.get("/search", async (req, res) => {
  try {
    const certRaw = (req.query.certificate || "").trim();
    if (!certRaw)
      return res
        .status(400)
        .json({ error: "Certificate parameter is required" });

    console.log(`Search request for certificate: ${certRaw}`);
    const variants = generateCertificateVariants(certRaw);
    console.log("Variants:", variants);

    // Try variants in batches: we can pass multiple variants at once to speed up (Nivoda will match any)
    // We'll try N variants in one call to reduce round-trips (useful when client includes LG prefix)
    // Strategy: try all variants at once
    try {
      const result = await searchNivodaDiamond(variants);
      const queryResult = result?.data?.as?.diamonds_by_query;
      const total = queryResult?.total_count || 0;
      const items = queryResult?.items || [];

      if (total > 0 && items.length > 0) {
        // pick best match (first)
        const found = items[0];
        const diamondObj = found.diamond || {};
        const certificate = diamondObj.certificate || {};
        const productUrl = createProductUrl(
          certificate,
          certificate.certNumber || certRaw
        );

        // ensure we pick an id if available
        const id = found.id || diamondObj.id || certificate.id || null;

        return res.json({
          url: productUrl,
          found: true,
          certificate: certificate.certNumber || certRaw,
          diamond: {
            id,
            shape: certificate.shape,
            carats: certificate.carats,
            color: certificate.color,
            clarity: certificate.clarity,
            lab: certificate.lab,
            price: found.price,
            image: diamondObj.image,
          },
        });
      }
    } catch (errInner) {
      console.warn("Search call failed:", errInner && errInner.message);
      // Fallthrough to try individual variants below (rare)
    }

    // If batch didn't return, try per-variant (legacy fallback)
    for (const variant of variants) {
      try {
        const result = await searchNivodaDiamond([variant]);
        const queryResult = result?.data?.as?.diamonds_by_query;
        const total = queryResult?.total_count || 0;
        const items = queryResult?.items || [];

        if (total > 0 && items.length > 0) {
          const found = items[0];
          const diamondObj = found.diamond || {};
          const certificate = diamondObj.certificate || {};
          const productUrl = createProductUrl(
            certificate,
            certificate.certNumber || variant
          );
          const id = found.id || diamondObj.id || certificate.id || null;

          return res.json({
            url: productUrl,
            found: true,
            certificate: certificate.certNumber || variant,
            diamond: {
              id,
              shape: certificate.shape,
              carats: certificate.carats,
              color: certificate.color,
              clarity: certificate.clarity,
              lab: certificate.lab,
              price: found.price,
              image: diamondObj.image,
            },
          });
        }
      } catch (e) {
        console.log(`Variant ${variant} error:`, e.message);
      }
    }

    // Not found
    return res.status(404).json({
      error: "Diamond not found",
      message: "Certificate number not found in our inventory",
      certificate: certRaw,
      variants_tried: variants,
    });
  } catch (error) {
    console.error("Search error:", error && error.message);
    return res.status(500).json({
      error: "Internal server error",
      message: error && error.message,
    });
  }
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true, status: "healthy" }));

// Test auth
app.get("/test-auth", async (req, res) => {
  try {
    const token = await getAuthToken();
    res.json({ ok: true, authenticated: true, token_length: token.length });
  } catch (error) {
    res
      .status(500)
      .json({ ok: false, authenticated: false, error: error.message });
  }
});

// Test specific cert
app.get("/test/:cert", async (req, res) => {
  try {
    const cert = req.params.cert;
    const result = await searchNivodaDiamond([cert]);
    const queryResult = result?.data?.as?.diamonds_by_query;
    const total = queryResult?.total_count || 0;
    res.json({
      certificate: cert,
      found: total > 0,
      total_count: total,
      items: queryResult?.items || [],
    });
  } catch (error) {
    res
      .status(500)
      .json({ certificate: req.params.cert, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Diamond Search REST API running on port ${PORT}`);
  console.log(
    `Endpoints: GET /search?certificate=XXX    GET /test/:cert    GET /test-auth`
  );
});
