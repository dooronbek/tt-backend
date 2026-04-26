// server.js — main Express server
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const odoo    = require('./odoo');
const { fetchPlaceFromLink } = require('./twogis');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── POST /parse-link ──────────────────────────────────────────────────────────
// Body: { url: "https://2gis.kg/..." }
// Returns: { name, street, city, lat, lng, warning? }
app.post('/parse-link', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url обязателен' });

  try {
    const place = await fetchPlaceFromLink(url);
    res.json(place);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ── POST /submit ──────────────────────────────────────────────────────────────
// Body (multipart/form-data):
//   name     — trade point name (e.g. "GLOBUS")
//   street   — street address
//   city     — city
//   lat, lng — coordinates
//   tag      — "Магазин" | "Спорт и фитнес"
//   photo    — image file (jpeg/png)
app.post('/submit', upload.single('photo'), async (req, res) => {
  const { name, street, city, lat, lng, tag } = req.body;

  if (!name || !lat || !lng || !tag) {
    return res.status(400).json({ error: 'Обязательные поля: name, lat, lng, tag' });
  }

  try {
    // 1. Get Kyrgyzstan country ID
    const countryId = await odoo.getKyrgyzstanId();

    // 2. Get or create tag ID
    const tagId = await odoo.getOrCreateTagId(tag);

    // 3. Convert photo to base64 if provided
    let imageBase64 = null;
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
    }

    // 4. Create Contact (res.partner)
    const partnerId = await odoo.createContact({
      name,
      street,
      city,
      lat,
      lng,
      countryId,
      tagIds: [[6, 0, [tagId]]],  // Odoo many2many syntax: replace all
      imageBase64,
    });

    // 5. Create CRM Lead linked to the contact
    const leadId = await odoo.createLead({
      name: `ТТ ${name}`,
      partnerId,
    });

    res.json({
      ok: true,
      partnerId,
      leadId,
      message: `Контакт #${partnerId} и лид #${leadId} созданы в Odoo`,
    });

  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ TT Bridge server running on http://localhost:${PORT}`);
  console.log(`   Odoo: ${process.env.ODOO_URL}`);
});
