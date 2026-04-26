// server.js
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

const STAGE_ORDER = ['Неактивные', 'На рассмотрении', 'Активные', 'Отказали'];

app.get('/health', (req, res) => res.json({ ok: true }));

// GET /me — returns the Odoo user ID for the credentials in .env
app.get('/me', async (req, res) => {
    try {
          const uid   = await odoo.authenticate();
          const users = await odoo.call('res.users', 'read', [[uid]], { fields: ['id', 'name', 'login'] });
          res.json({ ok: true, user: users[0] });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.post('/parse-link', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url обязателен' });
    try { res.json(await fetchPlaceFromLink(url)); }
    catch (err) { res.status(422).json({ error: err.message }); }
});

app.post('/submit', upload.single('photo'), async (req, res) => {
    const { name, street, city, lat, lng, tag } = req.body;
    if (!name || !lat || !lng || !tag)
          return res.status(400).json({ error: 'Обязательные поля: name, lat, lng, tag' });
    try {
          const countryId = await odoo.getKyrgyzstanId();
          const tagId     = await odoo.getOrCreateTagId(tag);
          let imageBase64 = null;
          if (req.file) imageBase64 = req.file.buffer.toString('base64');
          const partnerId = await odoo.createContact({ name, street, city, lat, lng, countryId, tagIds: [[6, 0, [tagId]]], imageBase64 });
          const leadId    = await odoo.createLead({ name: `ТТ ${name}`, partnerId });
          res.json({ ok: true, partnerId, leadId });
    } catch (err) {
          console.error('Submit error:', err);
          res.status(500).json({ error: err.message });
    }
});

// GET /pipeline?userId=N
// Fetches CRM leads filtered by user ID (Моя воронка)
// userId is required — each agent passes their own Odoo user ID
app.get('/pipeline', async (req, res) => {
    try {
          const domain = [];
          if (req.query.userId) {
                  domain.push(['user_id', '=', parseInt(req.query.userId)]);
          }

      const leads = await odoo.call('crm.lead', 'search_read', [domain], {
              fields: ['id', 'name', 'stage_id', 'partner_id', 'user_id', 'probability', 'description', 'priority'],
              order: 'write_date desc',
              limit: 200,
      });

      const grouped = {};
          for (const lead of leads) {
                  const stage = lead.stage_id ? lead.stage_id[1] : 'Без стадии';
                  if (!grouped[stage]) grouped[stage] = [];
                  grouped[stage].push({
                            id:          lead.id,
                            name:        lead.name,
                            stage:       stage,
                            contact:     lead.partner_id ? lead.partner_id[1] : '—',
                            partnerId:   lead.partner_id ? lead.partner_id[0] : null,
                            manager:     lead.user_id   ? lead.user_id[1]   : '—',
                            probability: lead.probability,
                            notes:       lead.description || '',
                            priority:    lead.priority || '0',
                  });
          }

      const ordered = {};
          for (const s of STAGE_ORDER) { if (grouped[s]) ordered[s] = grouped[s]; }
          for (const s of Object.keys(grouped)) { if (!ordered[s]) ordered[s] = grouped[s]; }

      res.json({ ok: true, pipeline: ordered, total: leads.length });
    } catch (err) {
          console.error('Pipeline error:', err);
          res.status(500).json({ error: err.message });
    }
});

app.patch('/lead/:id/stage', async (req, res) => {
    const leadId = parseInt(req.params.id);
    const { stage, notes } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage обязателен' });
    try {
          const stageIds = await odoo.call('crm.stage', 'search', [[['name', '=', stage]]], { limit: 1 });
          if (!stageIds.length) throw new Error(`Стадия "${stage}" не найдена`);
          const vals = { stage_id: stageIds[0] };
          if (notes) vals.description = notes;
          await odoo.call('crm.lead', 'write', [[leadId], vals]);
          res.json({ ok: true, leadId, stage });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.post('/contact-person', async (req, res) => {
    const { partnerId, name, phone, jobTitle } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    try {
          const vals = { name, phone: phone || '', function: jobTitle || '', type: 'contact' };
          if (partnerId) vals.parent_id = parseInt(partnerId);
          const contactId = await odoo.call('res.partner', 'create', [vals]);
          res.json({ ok: true, contactId });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.patch('/partner/:id/retail-price', async (req, res) => {
    const partnerId = parseInt(req.params.id);
    const { price } = req.body;
    if (!price) return res.status(400).json({ error: 'price обязателен' });
    try {
          await odoo.call('res.partner', 'write', [[partnerId], { x_retail_price: parseFloat(price) }]);
          res.json({ ok: true, partnerId, price });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`TT Bridge running on port ${PORT}`);
    console.log(`Odoo: ${process.env.ODOO_URL}`);
});
