// server.js (REST API Wrapper for Nivoda GraphQL)
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
      callback(null, true);
    }
  },
  credentials: true
}));

const NIVODA_API = process.env.NIVODA_API;
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const MAP_BASE_URL = process.env.MAP_BASE_URL;

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
      "Accept": "application/json"
    },
    body: JSON.stringify({ query: authQuery }),
  });

  const authText = await authResponse.text();
  
  if (!authResponse.ok) {
    throw new Error(`Authentication failed: ${authResponse.status}`);
  }

  const authJson = JSON.parse(authText);
  
  if (authJson.errors) {
    throw new Error("GraphQL Auth Error: " + JSON.stringify(authJson.errors));
  }

  const token = authJson?.data?.authenticate?.username_and_password?.token;
  if (!token) {
    throw new Error("Failed to get authentication token");
  }

  cachedToken = token;
  tokenExpiry = now + 1000 * 60 * 60 * 4; // Cache for 4 hours
  return token;
}

// Query Nivoda GraphQL API
async function searchNivodaDiamond(cert) {
  const token = await getAuthToken();
  
  const diamondQuery = `
    query SearchByCertificate($token: String!, $certNumber: String!) {
      as(token: $token) {
        diamonds_by_query(
          query: { 
            certificate_numbers: [$certNumber]
          },
          limit: 5
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
            discount
            availability
          }
        }
      }
    }
  `;

  const variables = {
    token: token,
    certNumber: cert
  };

  const response = await fetchFn(NIVODA_API, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ 
      query: diamondQuery,
      variables: variables
    }),
  });

  const text = await response.text();
  
  if (!response.ok) {
    throw new Error(`Nivoda API Error: ${response.status}`);
  }

  const json = JSON.parse(text);
  
  if (json.errors) {
    throw new Error("GraphQL Error: " + JSON.stringify(json.errors));
  }

  return json;
}

// Create Shopify product URL
function createProductUrl(diamond, cert) {
  const certificate = diamond.certificate || {};
  const shape = certificate.shape || 'Diamond';
  const carats = certificate.carats || '';
  const lab = certificate.lab || '';
  const color = certificate.color || '';
  const clarity = certificate.clarity || '';
  
  // Create descriptive product title
  const parts = [carats + 'ct', shape, lab, color, clarity, cert].filter(Boolean);
  const productTitle = parts.join('-');
  
  // Create URL handle (Shopify-friendly)
  const handle = productTitle.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return `${MAP_BASE_URL}${handle}`;
}

// Generate certificate variants
function generateCertificateVariants(cert) {
  return Array.from(
    new Set([
      cert,                                    // Original: LG628496664
      cert.toUpperCase(),                      // Uppercase: LG628496664
      cert.toLowerCase(),                      // Lowercase: lg628496664
      cert.replace(/^LG/i, ''),               // Remove LG prefix: 628496664
      cert.replace(/^LG/i, '').padStart(10, '0'), // Pad with zeros: 0628496664
      cert.replace(/[^0-9]/g, ''),            // Numbers only: 628496664
      cert.replace(/\s+/g, ''),               // Remove spaces
      cert.replace(/^0+/, ''),                // Remove leading zeros
    ])
  ).filter(v => v && v.length >= 3);
}

// 🎯 MAIN REST API ENDPOINT (Like Aurelinne's)
app.get("/search", async (req, res) => {
  try {
    const cert = (req.query.certificate || "").trim();
    
    if (!cert) {
      return res.status(400).json({ 
        error: "Certificate parameter is required" 
      });
    }

    console.log(`Searching for certificate: ${cert}`);

    // Generate certificate variants
    const variants = generateCertificateVariants(cert);
    
    // Try each variant until we find a match
    for (const variant of variants) {
      try {
        console.log(`Trying variant: ${variant}`);
        
        const result = await searchNivodaDiamond(variant);
        
        const queryResult = result?.data?.as?.diamonds_by_query;
        const total = queryResult?.total_count || 0;
        const items = queryResult?.items || [];
        
        if (total > 0 && items.length > 0) {
          const item = items[0];
          const productUrl = createProductUrl(item.diamond, variant);
          
          console.log(`Found diamond! Redirecting to: ${productUrl}`);
          
          // 🎯 SIMPLE RESPONSE LIKE AURELINNE
          return res.json({
            url: productUrl,
            found: true,
            certificate: variant,
            diamond: {
              id: item.id,
              shape: item.diamond.certificate?.shape,
              carats: item.diamond.certificate?.carats,
              color: item.diamond.certificate?.color,
              clarity: item.diamond.certificate?.clarity,
              lab: item.diamond.certificate?.lab,
              price: item.price,
              image: item.diamond.image
            }
          });
        }
      } catch (variantError) {
        console.log(`Variant ${variant} failed:`, variantError.message);
        // Continue to next variant
      }
    }

    // No diamond found
    console.log(`No diamond found for certificate: ${cert}`);
    return res.status(404).json({
      error: "Diamond not found",
      message: "Certificate number not found in our inventory",
      certificate: cert,
      variants_tried: variants
    });

  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({ 
      error: "Internal server error",
      message: "Something went wrong while searching"
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

// Test authentication
app.get("/test-auth", async (req, res) => {
  try {
    const token = await getAuthToken();
    res.json({ 
      ok: true, 
      authenticated: true,
      token_length: token.length 
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      authenticated: false,
      error: error.message 
    });
  }
});

// Test specific certificate
app.get("/test/:cert", async (req, res) => {
  try {
    const cert = req.params.cert;
    const result = await searchNivodaDiamond(cert);
    
    const queryResult = result?.data?.as?.diamonds_by_query;
    const total = queryResult?.total_count || 0;
    
    res.json({
      certificate: cert,
      found: total > 0,
      total_count: total,
      items: queryResult?.items || []
    });
  } catch (error) {
    res.status(500).json({ 
      certificate: req.params.cert,
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 Diamond Search REST API`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`\n📋 Endpoints:`);
  console.log(`   GET /search?certificate=XXX - Search diamonds (like Aurelinne)`);
  console.log(`   GET /health - Health check`);
  console.log(`   GET /test-auth - Test Nivoda authentication`);
  console.log(`   GET /test/:cert - Test specific certificate\n`);
});