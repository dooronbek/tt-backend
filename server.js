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

const STAGE_MAP = {
              'New':         'Неактивные',
              'Proposition': 'Активные',
              'Qualified':   'На рассмотрении',
              'Won':         'Активные',
              'Lost':        'Отказали',
              'Cancelled':   'Отказали',
};
const STAGE_ORDER = ['Неактивные', 'На рассмотрении', 'Активные', 'Отказали'];
function mapStage(s) { return STAGE_MAP[s] || s; }

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/me', async (req, res) => {
              try {
                              const uid   = await odoo.authenticate();
                              const users = await odoo.call('res.users', 'read', [[uid]], { fields: ['id', 'name', 'login'] });
                              res.json({ ok: true, user: users[0] });
              } catch (err) { res.status(500).json({ error: err.message }); }
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
                              const leadId    = await odoo.createLead({ name: 'TT ' + name, partnerId });
                              res.json({ ok: true, partnerId, leadId });
              } catch (err) {
                              console.error('Submit error:', err);
                              res.status(500).json({ error: err.message });
              }
});

app.get('/pipeline', async (req, res) => {
              try {
                              const domain = [['type', '=', 'opportunity']];
                              if (req.query.userId) domain.push(['user_id', '=', parseInt(req.query.userId)]);
                              const leads = await odoo.call('crm.lead', 'search_read', [domain], {
                                                fields: ['id', 'name', 'stage_id', 'partner_id', 'user_id', 'probability', 'description', 'priority'],
                                                order: 'write_date desc', limit: 200,
                              });
                              const grouped = {};
                              for (const lead of leads) {
                                                const raw   = lead.stage_id ? lead.stage_id[1] : 'Без стадии';
                                                const stage = mapStage(raw);
                                                if (!grouped[stage]) grouped[stage] = [];
                                                grouped[stage].push({
                                                                    id: lead.id, name: lead.name, stage, rawStage: raw,
                                                                    contact:   lead.partner_id ? lead.partner_id[1] : '—',
                                                                    partnerId: lead.partner_id ? lead.partner_id[0] : null,
                                                                    manager:   lead.user_id   ? lead.user_id[1]   : '—',
                                                                    probability: lead.probability, notes: lead.description || '', priority: lead.priority || '0',
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
                              const reverse = { 'Неактивные': 'New', 'На рассмотрении': 'Qualified', 'Активные': 'Proposition', 'Отказали': 'Cancelled' };
                              const searchName = reverse[stage] || stage;
                              const stageIds = await odoo.call('crm.stage', 'search', [[['name', '=', searchName]]], { limit: 1 });
                              if (!stageIds.length) throw new Error('Stage not found: ' + stage);
                              const vals = { stage_id: stageIds[0] };
                              if (notes) vals.description = notes;
                              await odoo.call('crm.lead', 'write', [[leadId], vals]);
                              res.json({ ok: true, leadId, stage });
              } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/contact-person', async (req, res) => {
              const { partnerId, name, phone, jobTitle } = req.body;
              if (!name) return res.status(400).json({ error: 'name обязателен' });
              try {
                              const vals = { name, phone: phone || '', function: jobTitle || '', type: 'contact' };
                              if (partnerId) vals.parent_id = parseInt(partnerId);
                              const contactId = await odoo.call('res.partner', 'create', [vals]);
                              res.json({ ok: true, contactId });
              } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/partner/:id/retail-price', async (req, res) => {
              const partnerId = parseInt(req.params.id);
              const { price } = req.body;
              if (!price) return res.status(400).json({ error: 'price обязателен' });
              try {
                              await odoo.call('res.partner', 'write', [[partnerId], { x_retail_price: parseFloat(price) }]);
                              res.json({ ok: true, partnerId, price });
              } catch (err) { res.status(500).json({ error: err.message }); }
});

// SALES

app.get('/orders', async (req, res) => {
              try {
                              const domain = [];
                              if (req.query.userId) domain.push(['user_id', '=', parseInt(req.query.userId)]);
                              const orders = await odoo.call('sale.order', 'search_read', [domain], {
                                                fields: ['id', 'name', 'state', 'partner_id', 'amount_total', 'date_order', 'note', 'invoice_status'],
                                                order: 'date_order desc', limit: 100,
                              });
                              const orderIds = orders.map(o => o.id);
                              let lineMap = {};
                              if (orderIds.length) {
                                                const lines = await odoo.call('sale.order.line', 'search_read',
                                                                                      [[['order_id', 'in', orderIds]]],
                                                                              { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_unit', 'name'], limit: 500 }
                                                                                    );
                                                lines.forEach(l => {
                                                                    const oid = l.order_id[0];
                                                                    if (!lineMap[oid]) lineMap[oid] = [];
                                                                    lineMap[oid].push({ name: l.product_id ? l.product_id[1] : l.name, qty: l.product_uom_qty, price_unit: l.price_unit });
                                                });
                              }
                              const result = orders.map(o => ({
                                                id: o.id, name: o.name, state: o.state,
                                                partner_name:   o.partner_id ? o.partner_id[1] : '—',
                                                partner_id:     o.partner_id ? o.partner_id[0] : null,
                                                amount_total:   o.amount_total,
                                                date_order:     o.date_order,
                                                payment_method: o.note || 'Наличные',
                                                delivered:      o.state === 'done',
                                                paid:           o.invoice_status === 'invoiced',
                                                order_lines:    lineMap[o.id] || [],
                              }));
                              res.json({ ok: true, orders: result });
              } catch (err) {
                              console.error('Orders error:', err);
                              res.status(500).json({ error: err.message });
              }
});

app.post('/order', async (req, res) => {
              const { partnerId, leadId, lines, payMethod } = req.body;
              if (!partnerId || !lines || !lines.length)
                              return res.status(400).json({ error: 'partnerId and lines required' });
              try {
                              const orderId = await odoo.call('sale.order', 'create', [{
                                                partner_id:     parseInt(partnerId),
                                                opportunity_id: leadId ? parseInt(leadId) : false,
                                                note:           payMethod || 'Наличные',
                                                order_line:     lines.map(l => [0, 0, {
                                                                    product_id:       parseInt(l.productId),
                                                                    product_uom_qty:  l.qty,
                                                                    price_unit:       l.price,
                                                }]),
                              }]);
                              await odoo.call('sale.order', 'action_confirm', [[orderId]]);
                              res.json({ ok: true, orderId });
              } catch (err) {
                              console.error('Create order error:', err);
                              res.status(500).json({ error: err.message });
              }
});

app.post('/order/:id/deliver', async (req, res) => {
              const orderId = parseInt(req.params.id);
              try {
                              await odoo.call('sale.order', 'action_done', [[orderId]]);
                              res.json({ ok: true, orderId, delivered: true });
              } catch (err) {
                              console.error('Deliver error:', err);
                              res.status(500).json({ error: err.message });
              }
});

app.post('/order/:id/pay', async (req, res) => {
              const orderId = parseInt(req.params.id);
              try {
                              const invoiceIds = await odoo.call('sale.order', '_create_invoices', [[orderId]]);
                              const ids = Array.isArray(invoiceIds) ? invoiceIds : [invoiceIds];
                              for (const invId of ids) {
                                                await odoo.call('account.move', 'action_post', [[invId]]);
                              }
                              res.json({ ok: true, orderId, invoiceIds: ids });
              } catch (err) {
                              console.error('Pay error:', err);
                              res.status(500).json({ error: err.message });
              }
});

app.post('/order/:id/confirm', async (req, res) => {
              const orderId = parseInt(req.params.id);
              try {
                              await odoo.call('sale.order', 'action_confirm', [[orderId]]);
                              res.json({ ok: true, orderId });
              } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/contacts/:partnerId', async (req, res) => {
    try {
          const contacts = await odoo.call('res.partner', 'search_read', [[['parent_id', '=', parseInt(req.params.partnerId)], ['type', '=', 'contact']]], { fields: ['id', 'name', 'phone', 'function'], limit: 20 });
          res.json({ ok: true, contacts: contacts.map(c => ({ id: c.id, name: c.name, phone: c.phone || '', job: c.function || '' })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/partner-phone/:id', async (req, res) => {
    try {
          const p = await odoo.call('res.partner', 'read', [[parseInt(req.params.id)]], { fields: ['phone', 'mobile'] });
          const phone = p[0]?.mobile || p[0]?.phone || '';
          res.json({ ok: true, phone });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
              console.log('TT Bridge running on port ' + PORT);
              console.log('Odoo: ' + process.env.ODOO_URL);
});
