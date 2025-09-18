// server.js (Enhanced version with Shopify integration)
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
      'http://localhost:3000', // for development
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const NIVODA_API = process.env.NIVODA_API;
const NIVODA_USER = process.env.NIVODA_USER;
const NIVODA_PASS = process.env.NIVODA_PASS;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const MAP_BASE_URL = process.env.MAP_BASE_URL || "";
const USE_BASIC_AUTH = (process.env.USE_BASIC_AUTH || "false").toLowerCase() === "true";

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

async function postGraphQL(query) {
  if (USE_BASIC_AUTH) {
    const basic = Buffer.from(`${NIVODA_USER}:${NIVODA_PASS}`).toString("base64");
    return fetchFn(NIVODA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({ query }),
    });
  } else {
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

// Enhanced diamond query with more details
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

// Shopify product creation/lookup
async function findOrCreateShopifyProduct(diamondData) {
  if (!SHOPIFY_STORE || !SHOPIFY_STOREFRONT_TOKEN) {
    console.log('Shopify credentials not configured, skipping product creation');
    return null;
  }

  const diamond = diamondData.diamond;
  const certificate = diamond.certificate;
  const certNumber = certificate.certNumber;

  // First, try to find existing product by certificate number
  const searchQuery = `
    query($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            handle
            title
            tags
          }
        }
      }
    }
  `;

  try {
    const searchResponse = await fetchFn(`https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({
        query: searchQuery,
        variables: { query: `tag:${certNumber}` }
      })
    });

    const searchResult = await searchResponse.json();
    
    if (searchResult.data?.products?.edges?.length > 0) {
      const product = searchResult.data.products.edges[0].node;
      return {
        found: true,
        productHandle: product.handle,
        productId: product.id,
        url: `https://${SHOPIFY_STORE}/products/${product.handle}`
      };
    }

    // If not found, create new product
    const productData = {
      product: {
        title: `${certificate.shape} Diamond - ${certificate.carats}ct - ${certNumber}`,
        body_html: `
          <h3>Diamond Specifications</h3>
          <ul>
            <li><strong>Certificate Number:</strong> ${certNumber}</li>
            <li><strong>Lab:</strong> ${certificate.lab}</li>
            <li><strong>Shape:</strong> ${certificate.shape}</li>
            <li><strong>Carat:</strong> ${certificate.carats}</li>
            <li><strong>Color:</strong> ${certificate.color}</li>
            <li><strong>Clarity:</strong> ${certificate.clarity}</li>
            <li><strong>Cut:</strong> ${certificate.cut}</li>
          </ul>
        `,
        vendor: 'Nivoda',
        product_type: 'Diamond',
        tags: [certNumber, certificate.lab, certificate.shape, 'nivoda'],
        images: diamond.image ? [{ src: diamond.image }] : [],
        variants: [{
          price: diamondData.price || '0.00',
          inventory_quantity: diamondData.availability === 'AVAILABLE' ? 1 : 0,
          sku: certNumber,
          title: 'Default Title'
        }]
      }
    };

    const createResponse = await fetchFn(`https://${SHOPIFY_STORE}/admin/api/2023-10/products.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN, // You'll need this
      },
      body: JSON.stringify(productData)
    });

    if (createResponse.ok) {
      const createdProduct = await createResponse.json();
      return {
        found: true,
        created: true,
        productHandle: createdProduct.product.handle,
        productId: createdProduct.product.id,
        url: `https://${SHOPIFY_STORE}/products/${createdProduct.product.handle}`
      };
    }

  } catch (error) {
    console.error('Shopify integration error:', error);
  }

  return null;
}

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Debug endpoint
app.get("/debug-auth", async (req, res) => {
  try {
    if (USE_BASIC_AUTH) {
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

// Main search endpoint
app.get("/search", async (req, res) => {
  try {
    const cert = (req.query.certificate || "").trim();
    if (!cert) {
      return res.status(400).json({ error: "certificate query param required" });
    }

    console.log(`Searching for certificate: ${cert}`);

    // Generate certificate variants to try
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
    
    for (const variant of variants) {
      console.log(`Trying variant: ${variant}`);
      const { status, json } = await queryByCertificate(variant);
      const total = json?.data?.diamonds_by_query?.total_count ?? 0;
      
      attempts.push({ variant, status, total, hasData: total > 0 });

      if (total > 0) {
        const item = json.data.diamonds_by_query.items[0];
        console.log('Found diamond:', item.diamond.certificate);
        
        // Try to find or create Shopify product
        const shopifyResult = await findOrCreateShopifyProduct(item);
        
        let redirectUrl;
        if (shopifyResult && shopifyResult.found) {
          redirectUrl = shopifyResult.url;
        } else {
          // Fallback to collection page with search
          redirectUrl = `https://${SHOPIFY_STORE}/collections/all_diamonds?search=${encodeURIComponent(cert)}`;
        }

        return res.json({
          found: true,
          variantMatched: variant,
          redirectUrl,
          item,
          shopifyProduct: shopifyResult,
          attempts
        });
      }
    }

    console.log('No diamonds found for any variant');
    return res.json({ found: false, attempts });

  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ 
      error: err.message || "server error",
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// OPTIONS handler for CORS
app.options('*', cors());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nivoda proxy server listening on port ${PORT}`);
  console.log(`USE_BASIC_AUTH: ${USE_BASIC_AUTH}`);
  console.log(`SHOP_DOMAIN: ${process.env.SHOP_DOMAIN}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});