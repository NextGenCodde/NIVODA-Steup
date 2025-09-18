// server.js (Debug Enhanced Version)
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
      callback(null, true); // Allow all origins for debugging
    }
  },
  credentials: true
}));

const NIVODA_API = process.env.NIVODA_API;
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

// Token caching for authenticate flow
let cachedToken = null;
let tokenExpiry = 0;

async function authenticateAndGetToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const authQuery = `{
    authenticate {
      username_and_password(username: "${NIVODA_USER}", password: "${NIVODA_PASS}") {
        token
      }
    }
  }`;

  console.log('Authenticating with Nivoda...');
  const r = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: authQuery }),
  });

  const text = await r.text();
  console.log('Auth Response Status:', r.status);
  console.log('Auth Response:', text);
  
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
  console.log('Authentication successful, token cached');
  return token;
}

async function postGraphQL(query) {
  console.log('Sending GraphQL Query:', query);
  
  if (USE_BASIC_AUTH) {
    const basic = Buffer.from(`${NIVODA_USER}:${NIVODA_PASS}`).toString("base64");
    console.log('Using Basic Auth');
    return fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basic}`,
      },
      body: JSON.stringify({ query }),
    });
  } else {
    const token = await authenticateAndGetToken();
    console.log('Using Bearer Token');
    return fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });
  }
}

// Test basic GraphQL connection
async function testConnection() {
  const testQuery = `
    query {
      diamonds_by_query(
        query: {},
        limit: 1
      ) {
        total_count
      }
    }
  `;
  
  try {
    const r = await postGraphQL(testQuery);
    const text = await r.text();
    console.log('Connection Test Status:', r.status);
    console.log('Connection Test Response:', text);
    return { status: r.status, response: text };
  } catch (error) {
    console.error('Connection Test Failed:', error);
    return { error: error.message };
  }
}

// Enhanced diamond query with better error handling
async function queryByCertificate(cert) {
  // Try different GraphQL query structures
  const queries = [
    // Query 1: Standard certificate_numbers array
    `
    query {
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
    `,
    // Query 2: Try with certificate_number (singular)
    `
    query {
      diamonds_by_query(
        query: { certificate_number: "${cert}" },
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
            }
          }
          price
        }
      }
    }
    `,
    // Query 3: Try search in general query
    `
    query {
      diamonds_by_query(
        query: { search: "${cert}" },
        limit: 5
      ) {
        total_count
        items {
          id
          diamond {
            id
            certificate {
              certNumber
              lab
            }
          }
          price
        }
      }
    }
    `
  ];

  const results = [];
  
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    console.log(`Trying query ${i + 1} for certificate: ${cert}`);
    
    try {
      const r = await postGraphQL(query);
      const text = await r.text();
      console.log(`Query ${i + 1} Status:`, r.status);
      console.log(`Query ${i + 1} Response:`, text);
      
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = { parseError: true, raw: text };
      }
      
      const result = { queryIndex: i + 1, status: r.status, json, rawText: text };
      results.push(result);
      
      // If this query was successful and found results, return it
      const total = json?.data?.diamonds_by_query?.total_count ?? 0;
      if (r.status === 200 && total > 0) {
        console.log(`Query ${i + 1} found ${total} diamonds!`);
        return result;
      }
      
      // If status is 200 but no results, continue to next query
      if (r.status === 200 && total === 0) {
        console.log(`Query ${i + 1} executed successfully but found 0 diamonds`);
        continue;
      }
      
      // If there's an error, log it but continue
      if (r.status !== 200) {
        console.log(`Query ${i + 1} failed with status ${r.status}`);
        continue;
      }
      
    } catch (error) {
      console.error(`Query ${i + 1} threw error:`, error);
      results.push({ queryIndex: i + 1, error: error.message });
    }
  }
  
  // If we get here, none of the queries found results
  return { allResults: results, status: 404, json: { data: { diamonds_by_query: { total_count: 0 } } } };
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Debug endpoint with connection test
app.get("/debug-auth", async (req, res) => {
  try {
    const authResult = USE_BASIC_AUTH 
      ? { ok: true, auth: "basic", user: NIVODA_USER }
      : await (async () => {
          const token = await authenticateAndGetToken();
          return { ok: true, auth: "token", token_sample: token.slice(0, 20) + "..." };
        })();
    
    // Test connection
    const connectionTest = await testConnection();
    
    return res.json({
      ...authResult,
      connectionTest
    });
  } catch (err) {
    console.error("debug-auth error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Enhanced search endpoint with detailed debugging
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
      if (result.json && result.json.data && result.json.data.diamonds_by_query) {
        total = result.json.data.diamonds_by_query.total_count || 0;
      }
      
      const attemptResult = { 
        variant, 
        status: result.status, 
        total, 
        hasData: total > 0,
        queryDetails: result.allResults || [{ queryIndex: result.queryIndex, status: result.status }]
      };
      
      attempts.push(attemptResult);

      if (total > 0) {
        const item = result.json.data.diamonds_by_query.items[0];
        console.log('FOUND DIAMOND:', item);
        
        // Create simple redirect URL for now
        const redirectUrl = `https://${SHOPIFY_STORE}/search?q=${encodeURIComponent(cert)}`;

        return res.json({
          found: true,
          variantMatched: variant,
          redirectUrl,
          item,
          attempts,
          debug: {
            originalCert: cert,
            matchedVariant: variant,
            nivodaResponse: result.json
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

// Test endpoint for manual testing
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
  console.log(`USE_BASIC_AUTH: ${USE_BASIC_AUTH}`);
  console.log(`SHOP_DOMAIN: ${process.env.SHOP_DOMAIN}`);
  console.log(`NIVODA_API: ${NIVODA_API}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});