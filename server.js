import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ CORS setup so Shopify frontend can call backend
app.use(
  cors({
    origin: process.env.FRONTEND_URL, // your Shopify domain
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const API_URL = process.env.API_URL;
const USERNAME = process.env.NIVODA_USERNAME;
const PASSWORD = process.env.NIVODA_PASSWORD;

// ---------------- AUTH FUNCTION ----------------
async function authenticate() {
  const query = `
    {
      authenticate {
        username_and_password(username: "${USERNAME}", password: "${PASSWORD}") {
          token
        }
      }
    }
  `;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const json = await res.json();
  return json.data.authenticate.username_and_password.token;
}
app.get("/health", (req, res) => {
  res.send("OK");
});
// ---------------- SEARCH ROUTE ----------------
app.post("/search", async (req, res) => {
  try {
    const { certNumber } = req.body;
    if (!certNumber) {
      return res.status(400).json({ success: false, message: "Certificate number required" });
    }

    const token = await authenticate();

    const query = `
      query {
        diamonds_by_query(
          query: { certificate_numbers: ["${certNumber}"] },
          limit: 1
        ) {
          items {
            diamond {
              id
              certificate {
                certNumber
              }
            }
          }
          total_count
        }
      }
    `;

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (data?.data?.diamonds_by_query?.total_count > 0) {
      const diamondId = data.data.diamonds_by_query.items[0].diamond.id;
      res.json({ success: true, id: diamondId });
    } else {
      res.json({ success: false, message: "No diamond found with this certificate number" });
    }
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ success: false, error: "Something went wrong" });
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
