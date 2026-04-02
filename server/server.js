require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const port = Number(process.env.PORT) || 8787;
const adminPassword = process.env.ADMIN_PASSWORD;
const corsOrigin = process.env.CORS_ORIGIN || "*";

if (!adminPassword) {
  throw new Error("Missing ADMIN_PASSWORD in server/.env");
}

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/admin/verify-password", (req, res) => {
  const password = String(req.body?.password || "").trim();

  if (!password) {
    return res.status(400).json({
      success: false,
      message: "Admin password is required"
    });
  }

  if (password !== adminPassword) {
    return res.status(401).json({
      success: false,
      message: "Invalid admin password"
    });
  }

  return res.json({
    success: true,
    message: "Password verified"
  });
});

app.listen(port, () => {
  console.log(`Admin gate API running on http://localhost:${port}`);
});
