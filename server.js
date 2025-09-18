// server.js (Fixed for Nivoda API)
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

// CORS configuration
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        process.env.SHOP_DOMAIN,
        "https://alturadiamonds.com",
        "http://localhost:3000",
      ].filter(Boolean);

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // Allow all origins for development
      }
    },
    credentials: true,
  })
);

const NIVODA_API = process.env.NIVODA_API; // https://integrations.nivoda.net/api/diamonds
const NIVODA_USER = process.env.NIVODA_USER; // info@alturadiamonds.com
const NIVODA_PASS = process.env.NIVODA_PASS; // Moneymove$1
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // alturadiamonds.com
const MAP_BASE_URL = process.env.MAP_BASE_URL; // https://alturadiamonds.com/products/

console.log("Server Config:", {
  NIVODA_API,
  NIVODA_USER: NIVODA_USER ? "***@" + NIVODA_USER.split("@")[1] : "NOT SET",
  SHOPIFY_STORE,
  MAP_BASE_URL,
});

// Token caching
let cachedToken = null;
let tokenExpiry = 0;

// Get authentication token
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    console.log("Using cached token");
    return cachedToken;
  }

  console.log("Getting new authentication token...");

  const authQuery = `{
    authenticate {
      username_and_password(username: "${NIVODA_USER}", password: "${NIVODA_PASS}") {
        token
      }
    }
  }`;

  const authResponse = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: authQuery }),
  });

  const authText = await authResponse.text();
  console.log("Auth Response Status:", authResponse.status);

  if (!authResponse.ok) {
    throw new Error(
      `Authentication failed: ${authResponse.status} - ${authText}`
    );
  }

  let authJson;
  try {
    authJson = JSON.parse(authText);
  } catch (e) {
    throw new Error("Auth response not JSON: " + authText);
  }

  const token = authJson?.data?.authenticate?.username_and_password?.token;
  if (!token) {
    throw new Error(
      "Failed to get authentication token. Response: " + authText
    );
  }

  cachedToken = token;
  tokenExpiry = now + 1000 * 60 * 60 * 5; // Cache for 5 hours
  console.log("Authentication token obtained successfully");
  return token;
}

// Query diamonds using certificate number
async function queryByCertificate(cert) {
  try {
    const token = await getAuthToken();

    const diamondQuery = `
      query {
        as(token: "${token}") {
          diamonds_by_query(
            query: { 
              certificate_numbers: ["${cert}"]
            },
            limit: 10
          ) {
            total_count
            items {
              id
              diamond {
                id
                image
                video
                certificate {
                  id
                  certNumber
                  lab
                  shape
                  carats
                  color
                  clarity
                  cut
                  polish
                  symmetry
                }
                measurements {
                  length
                  width
                  height
                }
              }
              price
              availability
            }
          }
        }
      }
    `;

    console.log("Querying certificate:", cert);

    const response = await fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: diamondQuery }),
    });

    const text = await response.text();
    console.log("Query Response Status:", response.status);

    if (!response.ok) {
      return {
        status: response.status,
        error: `API Error: ${response.status}`,
        rawText: text,
      };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return {
        status: response.status,
        error: "Invalid JSON response",
        rawText: text,
      };
    }

    return { status: response.status, json, rawText: text };
  } catch (error) {
    console.error("Query error:", error);
    return { status: 500, error: error.message };
  }
}

// Create Shopify product URL based on diamond data
function createProductUrl(diamond, cert) {
  try {
    const certificate = diamond.certificate || {};
    const shape = certificate.shape || "Diamond";
    const carats = certificate.carats || "";
    const lab = certificate.lab || "";

    // Create a product title similar to Aurelinne's format
    const productTitle = `${carats}ct ${shape} ${lab} ${cert}`.trim();

    // Create URL handle (Shopify-friendly slug)
    const handle = productTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // Remove special chars except spaces and hyphens
      .replace(/\s+/g, "-") // Replace spaces with hyphens
      .replace(/-+/g, "-") // Replace multiple hyphens with single
      .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens

    const productUrl = `${MAP_BASE_URL}${handle}`;
    console.log("Generated product URL:", productUrl);

    return productUrl;
  } catch (error) {
    console.error("Error creating product URL:", error);
    // Fallback URL
    return `${MAP_BASE_URL}diamond-${cert.toLowerCase()}`;
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// Debug authentication endpoint
app.get("/debug-auth", async (req, res) => {
  try {
    const token = await getAuthToken();

    // Test a basic query to verify token works
    const testQuery = `
      query {
        as(token: "${token}") {
          diamonds_by_query(query: {}, limit: 1) {
            total_count
          }
        }
      }
    `;

    const testResponse = await fetchFn(NIVODA_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: testQuery }),
    });

    const testText = await testResponse.text();

    return res.json({
      ok: true,
      authStatus: "success",
      tokenLength: token.length,
      connectionTest: {
        status: testResponse.status,
        hasData: testText.includes("total_count"),
      },
    });
  } catch (err) {
    console.error("Debug auth error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      authStatus: "failed",
    });
  }
});

// Main search endpoint
app.get("/search", async (req, res) => {
  try {
    const cert = (req.query.certificate || "").trim();
    if (!cert) {
      return res.status(400).json({
        error: "Certificate number is required",
        found: false,
      });
    }

    console.log(`\n=== SEARCHING FOR CERTIFICATE: ${cert} ===`);

    // Generate certificate variants to try
    const variants = Array.from(
      new Set([
        cert,
        cert.toUpperCase(),
        cert.toLowerCase(),
        cert.replace(/\s+/g, ""), // Remove spaces
        cert.replace(/[^0-9A-Za-z]/g, ""), // Remove all special chars
        cert.replace(/^0+/, ""), // Remove leading zeros
        cert.padStart(10, "0"), // Add leading zeros if short
      ])
    ).filter((v) => v && v.length >= 3); // Only valid variants

    console.log("Certificate variants to try:", variants);

    const attempts = [];

    for (const variant of variants) {
      console.log(`\n--- Trying variant: ${variant} ---`);
      const result = await queryByCertificate(variant);

      let total = 0;
      let items = [];

      if (
        result.json &&
        result.json.data &&
        result.json.data.as &&
        result.json.data.as.diamonds_by_query
      ) {
        const queryResult = result.json.data.as.diamonds_by_query;
        total = queryResult.total_count || 0;
        items = queryResult.items || [];
      }

      const attemptResult = {
        variant,
        status: result.status,
        total,
        hasData: total > 0,
        error: result.error || null,
      };

      attempts.push(attemptResult);

      // If we found diamonds, return the first available one
      if (total > 0 && items.length > 0) {
        const item = items[0];
        console.log("FOUND DIAMOND:", {
          id: item.id,
          cert: item.diamond?.certificate?.certNumber,
          shape: item.diamond?.certificate?.shape,
          carats: item.diamond?.certificate?.carats,
        });

        // Create product URL
        const redirectUrl = createProductUrl(item.diamond, variant);

        return res.json({
          found: true,
          variantMatched: variant,
          redirectUrl,
          diamond: {
            id: item.id,
            certificate: item.diamond.certificate,
            price: item.price,
            availability: item.availability,
            image: item.diamond.image,
            video: item.diamond.video,
          },
          attempts,
          debug: {
            originalCert: cert,
            matchedVariant: variant,
            totalFound: total,
          },
        });
      }
    }

    console.log("=== NO DIAMONDS FOUND FOR ANY VARIANT ===");
    return res.json({
      found: false,
      message: "Diamond certificate not found in our inventory",
      attempts,
      debug: {
        originalCert: cert,
        variantsTried: variants,
        totalAttempts: attempts.length,
      },
    });
  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({
      found: false,
      error: "Internal server error",
      message: "Something went wrong while searching. Please try again.",
      debug: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// Test endpoint with known certificates
app.get("/test-known", async (req, res) => {
  const knownCerts = ["LG628496664", "7235275727", "6385008601", "2233521189"];
  const results = [];

  for (const cert of knownCerts) {
    console.log(`Testing known certificate: ${cert}`);
    const result = await queryByCertificate(cert);
    results.push({
      cert,
      found: result.json?.data?.as?.diamonds_by_query?.total_count > 0,
      status: result.status,
      error: result.error,
    });
  }

  return res.json({ knownCertificateTests: results });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 Nivoda Diamond Search API Server`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🔗 API Endpoint: ${NIVODA_API}`);
  console.log(`🏪 Shopify Store: ${SHOPIFY_STORE}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET /health - Health check`);
  console.log(`   GET /search?certificate=XXX - Search for certificate`);
  console.log(`   GET /debug-auth - Test authentication`);
  console.log(`   GET /test-known - Test known certificates\n`);
});
