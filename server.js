// server.js (Corrected for Nivoda API)
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
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.SHOP_DOMAIN,
      'https://alturadiamonds.com',
      'http://localhost:3000',
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all origins for now
    }
  },
  credentials: true
}));

const NIVODA_API = process.env.NIVODA_API; // https://integrations.nivoda.net/api/diamonds
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const USE_BASIC_AUTH = (process.env.USE_BASIC_AUTH || "false").toLowerCase() === "true";

console.log('Server Config:', {
  NIVODA_API,
  NIVODA_USER,
  USE_BASIC_AUTH,
  SHOPIFY_STORE
});

// Token caching
let cachedToken = null;
let tokenExpiry = 0;

// Get authentication token
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    console.log('Using cached token');
    return cachedToken;
  }

  console.log('Getting new authentication token...');
  
  // First, authenticate to get token
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
  console.log('Auth Response Status:', authResponse.status);
  console.log('Auth Response:', authText);

  let authJson;
  try {
    authJson = JSON.parse(authText);
  } catch (e) {
    throw new Error("Auth response not JSON: " + authText);
  }

  const token = authJson?.data?.authenticate?.username_and_password?.token;
  if (!token) {
    throw new Error("Failed to get authentication token: " + authText);
  }

  cachedToken = token;
  tokenExpiry = now + 1000 * 60 * 60 * 5; // Cache for 5 hours
  console.log('Authentication token obtained successfully');
  return token;
}

// Query diamonds using the correct API structure
async function queryByCertificate(cert) {
  try {
    const token = await getAuthToken();
    
    // Use the correct query structure with as(token:...) wrapper
    const diamondQuery = `
      query {
        as(token: "${token}") {
          diamonds_by_query(
            query: { certificate_numbers: ["${cert}"] },
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
                  cut
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

    console.log('Querying with certificate:', cert);
    console.log('GraphQL Query:', diamondQuery);

    const response = await fetchFn(NIVODA_API, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: diamondQuery }),
    });

    const text = await response.text();
    console.log('Query Response Status:', response.status);
    console.log('Query Response:', text);

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { status: response.status, json: { parseError: true, raw: text }, rawText: text };
    }

    return { status: response.status, json, rawText: text };

  } catch (error) {
    console.error('Query error:', error);
    return { status: 500, error: error.message };
  }
}

// Create Shopify product URL (simplified for now)
function createProductUrl(diamond, cert) {
  const certificate = diamond.certificate;
  const productTitle = `${certificate.shape || 'Diamond'} ${certificate.carats}ct ${certificate.lab} ${cert}`;
  const handle = productTitle.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return `https://${SHOPIFY_STORE}/products/${handle}`;
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Debug endpoint
app.get("/debug-auth", async (req, res) => {
  try {
    const token = await getAuthToken();
    
    // Test a basic query
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
      auth: "token",
      token_sample: token.slice(0, 20) + "...",
      connectionTest: {
        status: testResponse.status,
        response: testText
      }
    });
  } catch (err) {
    console.error("debug-auth error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Main search endpoint
app.get("/search", async (req, res) => {
  try {
    const cert = (req.query.certificate || "").trim();
    if (!cert) {
      return res.status(400).json({ error: "certificate query param required" });
    }

    console.log(`\n=== SEARCHING FOR CERTIFICATE: ${cert} ===`);

    // Generate certificate variants to try
    const variants = Array.from(
      new Set([
        cert,
        cert.toUpperCase(),
        cert.toLowerCase(),
        cert.replace(/\s+/g, ""),
        cert.replace(/[^0-9A-Za-z]+/g, ""),
        cert.replace(/^0+/, ""),
      ])
    ).filter(Boolean);

    console.log('Certificate variants to try:', variants);

    const attempts = [];
    
    for (const variant of variants) {
      console.log(`\n--- Trying variant: ${variant} ---`);
      const result = await queryByCertificate(variant);
      
      let total = 0;
      let items = [];
      
      if (result.json && result.json.data && result.json.data.as && result.json.data.as.diamonds_by_query) {
        const queryResult = result.json.data.as.diamonds_by_query;
        total = queryResult.total_count || 0;
        items = queryResult.items || [];
      }
      
      const attemptResult = { 
        variant, 
        status: result.status, 
        total, 
        hasData: total > 0,
        error: result.error || null
      };
      
      attempts.push(attemptResult);

      if (total > 0) {
        const item = items[0];
        console.log('FOUND DIAMOND:', item);
        
        // Create product URL
        const redirectUrl = createProductUrl(item.diamond, variant);
        
        return res.json({
          found: true,
          variantMatched: variant,
          redirectUrl,
          item,
          attempts,
          debug: {
            originalCert: cert,
            matchedVariant: variant,
            totalFound: total
          }
        });
      }
    }

    console.log('=== NO DIAMONDS FOUND FOR ANY VARIANT ===');
    return res.json({ 
      found: false, 
      attempts,
      debug: {
        originalCert: cert,
        variantsTried: variants,
        totalAttempts: attempts.length
      }
    });

  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ 
      error: err.message || "server error",
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Test endpoint to try with known working certificates
app.get("/test-known", async (req, res) => {
  // Try with one of the certificate numbers from your test data
  const knownCerts = ["7235275727", "6385008601", "2233521189"];
  const results = [];
  
  for (const cert of knownCerts) {
    console.log(`Testing known certificate: ${cert}`);
    const result = await queryByCertificate(cert);
    results.push({ cert, result });
  }
  
  return res.json({ knownCertificateTests: results });
});

// Manual test endpoint
app.get("/test/:cert", async (req, res) => {
  try {
    const cert = req.params.cert;
    console.log('Manual test for certificate:', cert);
    
    const result = await queryByCertificate(cert);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nivoda proxy server listening on port ${PORT}`);
  console.log(`NIVODA_API: ${NIVODA_API}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});