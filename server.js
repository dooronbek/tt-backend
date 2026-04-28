// server.js - Universal (multi-agent with JWT auth)
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const https   = require('https');
const jwt     = require('jsonwebtoken');
const { fetchPlaceFromLink } = require('./twogis');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: '15mb' }));

const ODOO_URL = (process.env.ODOO_URL || 'https://kyraan.odoo.com').replace(/\/$/, '');
const ODOO_DB  = process.env.ODOO_DB  || 'kyraan';
const JWT_SECRET = process.env.JWT_SECRET || 'kinetik-secret-2026';

function m2o(f) { return Array.isArray(f) ? f : null; }

async function getSession(username, password) {
  const authPayload = JSON.stringify({ jsonrpc:'2.0', method:'call', params:{ db:ODOO_DB, login:username, password:password }});
  return new Promise((resolve, reject) => {
    const u = new URL(ODOO_URL + '/web/session/authenticate');
    const r = https.request({ hostname:u.hostname, path:u.pathname, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(authPayload)}}, res2 => {
      let body = ''; res2.on('data', d => body+=d);
      res2.on('end', () => {
        const json = JSON.parse(body);
        if (json.error) return reject(new Error(json.error.data?.message || 'Auth failed'));
        if (!json.result || !json.result.uid) return reject(new Error('Неверный логин или пароль'));
        const sid = (res2.headers['set-cookie']||[]).map(c=>c.split(';')[0]).find(c=>c.startsWith('session_id='));
        resolve({ sid, uid: json.result.uid, name: json.result.name });
      });
    });
    r.on('error', reject); r.write(authPayload); r.end();
  });
}

async function sessionRpc(sid, model, method, args, kwargs) {
  const body = JSON.stringify({jsonrpc:'2.0', method:'call', id:1, params:{model, method, args, kwargs:kwargs||{}}});
  return new Promise((resolve, reject) => {
    const u = new URL(ODOO_URL + '/web/dataset/call_kw');
    const r = https.request({ hostname:u.hostname, path:u.pathname, method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Cookie':sid}}, res2 => {
      let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>{
        const j = JSON.parse(d);
        if (j.error) reject(new Error(j.error.data?.message || JSON.stringify(j.error)));
        else resolve(j.result);
      });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.agent = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Сессия истекла. Войдите снова.' }); }
}

async function agentSession(req) {
  return getSession(req.agent.odooUsername, req.agent.odooPassword);
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const { uid, name, sid } = await getSession(username, password);
    // Fetch user's default warehouse
    let warehouseId = null, warehouseName = null;
    try {
      const users = await sessionRpc(sid, 'res.users', 'read', [[uid]], { fields: ['property_warehouse_id'] });
      const wf = Array.isArray(users[0].property_warehouse_id) ? users[0].property_warehouse_id : null;
      if (wf) { warehouseId = wf[0]; warehouseName = wf[1]; }
    } catch(e) { console.error('warehouse fetch error:', e.message); }
    const token = jwt.sign(
      { userId: uid, userName: name, odooUsername: username, odooPassword: password, warehouseId, warehouseName },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ ok: true, token, userId: uid, userName: name, warehouseId, warehouseName });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.use(authMiddleware);

const STAGE_MAP = {
  'New': 'Неактивные', 'Proposition': 'Активные', 'Qualified': 'На рассмотрении',
  'Won': 'Активные', 'Lost': 'Отказали', 'Cancelled': 'Отказали',
};
const STAGE_ORDER = ['Неактивные', 'На рассмотрении', 'Активные', 'Отказали'];
const STAGE_ID_MAP = { 'Неактивные': 1, 'На рассмотрении': 2, 'Активные': 3, 'Отказали': 5 };
function mapStage(s) { return STAGE_MAP[s] || s; }

app.post('/parse-link', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { res.json(await fetchPlaceFromLink(url)); }
  catch (err) { res.status(422).json({ error: err.message }); }
});

app.post('/submit', upload.single('photo'), async (req, res) => {
  const { name, street, city, lat, lng, tag } = req.body;
  if (!name || !lat || !lng || !tag) return res.status(400).json({ error: 'Required: name, lat, lng, tag' });
  try {
    const { sid } = await agentSession(req);
    const countries = await sessionRpc(sid, 'res.country', 'search', [[['code','=','KG']]], { limit: 1 });
    const countryId = countries[0] || null;
    const tagIds = await sessionRpc(sid, 'res.partner.category', 'search', [[['name','=',tag]]], { limit: 1 });
    let tagId = tagIds[0];
    if (!tagId) tagId = await sessionRpc(sid, 'res.partner.category', 'create', [{ name: tag }]);
    const partnerData = { name, street, city, country_id: countryId, partner_latitude: parseFloat(lat), partner_longitude: parseFloat(lng), category_id: [[6,0,[tagId]]] };
    if (req.file) partnerData.image_1920 = req.file.buffer.toString('base64');
    const partnerId = await sessionRpc(sid, 'res.partner', 'create', [partnerData]);
    const leadId = await sessionRpc(sid, 'crm.lead', 'create', [{ name: 'TT ' + name, partner_id: partnerId, type: 'opportunity' }]);
    res.json({ ok: true, partnerId, leadId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/pipeline', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const domain = [['type','=','opportunity'],['user_id','=',req.agent.userId]];
    const leads = await sessionRpc(sid, 'crm.lead', 'search_read', [domain], {
      fields: ['id','name','stage_id','partner_id','user_id','description','priority'],
      order: 'write_date desc', limit: 200,
    });
    const grouped = {};
    for (const lead of leads) {
      const stageF = m2o(lead.stage_id);
      const raw = stageF ? stageF[1] : 'Без стадии';
      const stage = mapStage(raw);
      const partF = m2o(lead.partner_id); const userF = m2o(lead.user_id);
      if (!grouped[stage]) grouped[stage] = [];
      grouped[stage].push({ id:lead.id, name:lead.name, stage, rawStage:raw,
        contact:partF?partF[1]:'—', partnerId:partF?partF[0]:null,
        manager:userF?userF[1]:'—', notes:lead.description||'', priority:lead.priority||'0' });
    }
    const ordered = {};
    for (const s of STAGE_ORDER) { if (grouped[s]) ordered[s] = grouped[s]; }
    for (const s of Object.keys(grouped)) { if (!ordered[s]) ordered[s] = grouped[s]; }
    res.json({ ok: true, pipeline: ordered, total: leads.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/lead/:id/stage', async (req, res) => {
  const { stage, notes } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage required' });
  try {
    const { sid } = await agentSession(req);
    const stageId = STAGE_ID_MAP[stage];
    if (!stageId) throw new Error('Stage not found: ' + stage);
    const vals = { stage_id: stageId };
    if (notes) vals.description = notes;
    await sessionRpc(sid, 'crm.lead', 'write', [[parseInt(req.params.id)], vals]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/contact-person', async (req, res) => {
  const { partnerId, name, phone, jobTitle } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { sid } = await agentSession(req);
    const vals = { name, phone:phone||'', function:jobTitle||'', type:'contact' };
    if (partnerId) vals.parent_id = parseInt(partnerId);
    const contactId = await sessionRpc(sid, 'res.partner', 'create', [vals]);
    res.json({ ok: true, contactId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/contacts/:partnerId', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const contacts = await sessionRpc(sid, 'res.partner', 'search_read',
      [[['parent_id','=',parseInt(req.params.partnerId)],['type','=','contact']]],
      { fields:['id','name','phone','function'], limit:20 });
    res.json({ ok:true, contacts:contacts.map(c=>({id:c.id,name:c.name,phone:c.phone||'',job:c.function||''})) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/partner-phone/:id', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const p = await sessionRpc(sid, 'res.partner', 'read', [[parseInt(req.params.id)]], { fields:['phone','mobile'] });
    res.json({ ok:true, phone:(p[0]||{}).mobile||(p[0]||{}).phone||'' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/partner-vat/:id', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const p = await sessionRpc(sid, 'res.partner', 'read', [[parseInt(req.params.id)]], { fields:['vat'] });
    res.json({ ok:true, vat:(p[0]||{}).vat||'' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/partner/:id/vat', async (req, res) => {
  const { vat } = req.body;
  if (vat === undefined) return res.status(400).json({ error: 'vat required' });
  try {
    const { sid } = await agentSession(req);
    await sessionRpc(sid, 'res.partner', 'write', [[parseInt(req.params.id)], { vat: vat||false }]);
    res.json({ ok:true, vat });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/partner/:id/retail-price', async (req, res) => {
  const { price } = req.body;
  if (!price) return res.status(400).json({ error: 'price required' });
  try {
    const { sid } = await agentSession(req);
    await sessionRpc(sid, 'res.partner', 'write', [[parseInt(req.params.id)], { x_retail_price: parseFloat(price) }]);
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/warehouses', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const wh = await sessionRpc(sid, 'stock.warehouse', 'search_read', [[]], { fields:['id','name','code','lot_stock_id'], limit:20 });
    res.json({ ok:true, warehouses:wh.map(w=>({ id:w.id, name:w.name, code:w.code, stockLocationId:m2o(w.lot_stock_id)?w.lot_stock_id[0]:null })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/orders', async (req, res) => {
  try {
    const { sid } = await agentSession(req);
    const domain = [['user_id','=',req.agent.userId]];
    const orders = await sessionRpc(sid, 'sale.order', 'search_read', [domain], {
      fields:['id','name','state','partner_id','amount_total','date_order','note','invoice_status','picking_ids'],
      order:'date_order desc', limit:100 });
    const orderIds = orders.map(o=>o.id);
    const lineMap = {};
    if (orderIds.length) {
      const lines = await sessionRpc(sid, 'sale.order.line', 'search_read', [[['order_id','in',orderIds]]],
        { fields:['order_id','product_id','product_uom_qty','price_unit','name'], limit:500 });
      for (const l of lines) {
        const oF=m2o(l.order_id); const pF=m2o(l.product_id); if(!oF)continue;
        const oid=oF[0]; if(!lineMap[oid])lineMap[oid]=[];
        lineMap[oid].push({name:pF?pF[1]:(l.name||'—'),qty:l.product_uom_qty,price_unit:l.price_unit});
      }
    }
    const allPids=[]; orders.forEach(o=>{if(Array.isArray(o.picking_ids))allPids.push(...o.picking_ids);});
    const pickMap={};
    if (allPids.length) {
      const picks=await sessionRpc(sid,'stock.picking','read',[allPids],{fields:['id','name','state','sale_id']});
      picks.forEach(p=>{const sF=m2o(p.sale_id);if(sF)pickMap[sF[0]]={pickingId:p.id,pickingName:p.name,pickingState:p.state};});
    }
    const partnerIds=[...new Set(orders.map(o=>{const f=m2o(o.partner_id);return f?f[0]:null;}).filter(Boolean))];
    const vatMap={};
    if(partnerIds.length){const ps=await sessionRpc(sid,'res.partner','read',[partnerIds],{fields:['id','vat']});ps.forEach(p=>{vatMap[p.id]=p.vat||'';});}
    const result=orders.map(o=>{
      const pF=m2o(o.partner_id); const pid=pF?pF[0]:null; const pick=pickMap[o.id]||{};
      return {id:o.id,name:o.name,state:o.state,partner_name:pF?pF[1]:'—',partner_id:pid,
        partner_vat:pid?(vatMap[pid]||''):'',amount_total:o.amount_total||0,date_order:o.date_order||'',
        payment_method:o.note||'Наличные',delivered:pick.pickingState==='done',paid:o.invoice_status==='invoiced',
        picking_id:pick.pickingId||null,picking_name:pick.pickingName||'',picking_state:pick.pickingState||'',
        order_lines:lineMap[o.id]||[]};
    });
    res.json({ ok:true, orders:result });
  } catch (err) { console.error('Orders error:',err); res.status(500).json({ error:err.message }); }
});

app.post('/order', async (req, res) => {
  const { partnerId, leadId, lines, payMethod } = req.body;
  if (!partnerId||!lines||!lines.length) return res.status(400).json({ error: 'partnerId and lines required' });
  try {
    const { sid } = await agentSession(req);
    const orderId = await sessionRpc(sid,'sale.order','create',[{partner_id:parseInt(partnerId),
      opportunity_id:leadId?parseInt(leadId):false, note:payMethod||'Наличные',
      order_line:lines.map(l=>[0,0,{product_id:parseInt(l.productId),product_uom_qty:l.qty,price_unit:l.price}])}]);
    await sessionRpc(sid,'sale.order','action_confirm',[[orderId]]);
    res.json({ ok:true, orderId });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/order/:id/deliver', async (req, res) => {
  const orderId=parseInt(req.params.id); const {pickingId,warehouseLocationId}=req.body;
  try {
    const { sid } = await agentSession(req);
    let pid=pickingId;
    if (!pid) { const o=await sessionRpc(sid,'sale.order','read',[[orderId]],{fields:['picking_ids']}); pid=o[0].picking_ids&&o[0].picking_ids[0]; }
    if (!pid) throw new Error('No delivery found');
    if (warehouseLocationId) await sessionRpc(sid,'stock.picking','write',[[pid],{location_id:parseInt(warehouseLocationId)}]);
    await sessionRpc(sid,'stock.picking','button_validate',[[pid]]);
    res.json({ ok:true, orderId, pickingId:pid });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post('/order/:id/pay', async (req, res) => {
  const orderId=parseInt(req.params.id); const {payMethod}=req.body||{};
  const journalId=payMethod==='Перевод'?6:9;
  try {
    const { sid } = await agentSession(req);
    if (payMethod) {
      const pmLineId=payMethod==='Перевод'?5:7;
      await sessionRpc(sid,'sale.order','write',[[orderId],{note:payMethod,preferred_payment_method_line_id:pmLineId}]);
    }
    const order=await sessionRpc(sid,'sale.order','read',[[orderId]],{fields:['invoice_ids']});
    let invoiceIds=order[0].invoice_ids||[];
    if (!invoiceIds.length) {
      const wizId=await sessionRpc(sid,'sale.advance.payment.inv','create',[{advance_payment_method:'delivered',sale_order_ids:[orderId]}]);
      await sessionRpc(sid,'sale.advance.payment.inv','create_invoices',[[wizId]]);
      const o2=await sessionRpc(sid,'sale.order','read',[[orderId]],{fields:['invoice_ids']}); invoiceIds=o2[0].invoice_ids||[];
    }
    if (!invoiceIds.length) throw new Error('Не удалось создать счёт. Проверьте доставку.');
    const drafts=await sessionRpc(sid,'account.move','search',[[['id','in',invoiceIds],['state','=','draft']]]);
    if (!drafts.length) throw new Error('Счёт уже подтверждён');
    await sessionRpc(sid,'account.move','write',[drafts,{journal_id:journalId}]);
    await sessionRpc(sid,'account.move','action_post',[drafts]);
    res.json({ ok:true, orderId });
  } catch (err) { console.error('Pay error:',err); res.status(500).json({ error:err.message }); }
});

app.get('/picking/:id/pdf', async (req, res) => {
  const pickingId=parseInt(req.params.id);
  try {
    const { sid } = await agentSession(req);
    const chunks=await new Promise((resolve,reject)=>{
      const u=new URL(ODOO_URL+'/report/pdf/stock.action_report_delivery/'+pickingId);
      const r=https.request({hostname:u.hostname,path:u.pathname,method:'GET',headers:{Cookie:sid}},res2=>{
        if(res2.statusCode!==200){reject(new Error('PDF status '+res2.statusCode));return;}
        const c=[];res2.on('data',d=>c.push(d));res2.on('end',()=>resolve(c));res2.on('error',reject);
      });r.on('error',reject);r.end();
    });
    res.set('Content-Type','application/pdf');
    res.set('Content-Disposition','attachment; filename=nakladnaya_'+pickingId+'.pdf');
    res.send(Buffer.concat(chunks));
  } catch (err) { res.status(500).json({ error:err.message }); }
});


const PORT=process.env.PORT||3001;
app.listen(PORT,()=>{
  console.log('TT Universal running on port '+PORT);
  console.log('Odoo: '+ODOO_URL);
});
