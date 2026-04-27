// odoo.js — Odoo XML-RPC client
const xmlrpc = require('xmlrpc');
const url = require('url');

class OdooClient {
  constructor() {
    const odooUrl = new url.URL(process.env.ODOO_URL);
    const isHttps = odooUrl.protocol === 'https:';
    const host = odooUrl.hostname;
    const port = odooUrl.port || (isHttps ? 443 : 80);

    const clientOpts = { host, port, path: '/xmlrpc/2/common' };
    const objOpts   = { host, port, path: '/xmlrpc/2/object' };

    this.common = isHttps
      ? xmlrpc.createSecureClient(clientOpts)
      : xmlrpc.createClient(clientOpts);

    this.object = isHttps
      ? xmlrpc.createSecureClient(objOpts)
      : xmlrpc.createClient(objOpts);

    this.db       = process.env.ODOO_DB;
    this.username = process.env.ODOO_USERNAME;
    this.password = process.env.ODOO_PASSWORD;
    this.uid      = null;
  }

  // Authenticate and cache uid
  async authenticate() {
    if (this.uid) return this.uid;
    return new Promise((resolve, reject) => {
      this.common.methodCall('authenticate',
        [this.db, this.username, this.password, {}],
        (err, uid) => {
          if (err) return reject(new Error('Odoo auth failed: ' + err.message));
          if (!uid) return reject(new Error('Invalid Odoo credentials'));
          this.uid = uid;
          resolve(uid);
        }
      );
    });
  }

  // Generic execute_kw wrapper
  async call(model, method, args, kwargs = {}) {
    const uid = await this.authenticate();
    return new Promise((resolve, reject) => {
      this.object.methodCall('execute_kw',
        [this.db, uid, this.password, model, method, args, kwargs],
        (err, result) => {
          if (err) return reject(new Error(`Odoo ${model}.${method} failed: ${err.message}`));
          resolve(result);
        }
      );
    });
  }

  // ── Contacts ─────────────────────────────────────────

  async createContact({ name, street, city, lat, lng, countryId, tagIds, imageBase64 }) {
    const vals = {
      name,
      street,
      city,
      country_id: countryId,
      partner_latitude:  parseFloat(lat),
      partner_longitude: parseFloat(lng),
      is_company: true,
      category_id: tagIds,
    };
    if (imageBase64) {
      vals.image_1920 = imageBase64;
    }
    return await this.call('res.partner', 'create', [vals]);
  }

  // Find Kyrgyzstan country id
  async getKyrgyzstanId() {
    const ids = await this.call('res.country', 'search',
      [[['code', '=', 'KG']]], { limit: 1 });
    return ids[0] || null;
  }

  // Find tag id by name, create if missing
  async getOrCreateTagId(tagName) {
    const ids = await this.call('res.partner.category', 'search',
      [[['name', '=', tagName]]], { limit: 1 });
    if (ids.length) return ids[0];
    return await this.call('res.partner.category', 'create', [{ name: tagName }]);
  }

  // ── CRM Leads ─────────────────────────────────────────

  async createLead({ name, partnerId }) {
    return await this.call('crm.lead', 'create', [{
      name,           // "ТТ GLOBUS"
      partner_id: partnerId,
      type: opportunity',
    }]);
  }
}

module.exports = new OdooClient();
