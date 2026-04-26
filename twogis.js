// twogis.js — 2GIS link parser + Places API client
const axios = require('axios');

const BASE = 'https://catalog.api.2gis.com/3.0';

// ── Link parser ───────────────────────────────────────────────────────────────
// Handles formats:
//   https://2gis.kg/bishkek/firm/70000001043165232/42.841427,74.637059
//   https://go.2gis.com/XXXXX  (short links — resolved via redirect)
//   https://2gis.kg/bishkek/geo/70030076284854932/74.589584,42.870204

function parseCoords(url) {
  const m = url.match(/([0-9]{2,3}\.[0-9]{4,}),([0-9]{2,3}\.[0-9]{4,})/);
  if (!m) return null;
  return { lat: m[1], lng: m[2] };
}

function parseFirmId(url) {
  const m = url.match(/\/firm\/([0-9]+)/);
  return m ? m[1] : null;
}

function parseCity(url) {
  const m = url.match(/2gis\.[a-z]+\/([a-z_-]+)\//);
  if (!m) return 'Bishkek';
  const cityMap = {
    bishkek: 'Бишкек',
    osh: 'Ош',
    jalal_abad: 'Джалал-Абад',
    karakol: 'Каракол',
    tokmok: 'Токмок',
    balykchy: 'Балыкчы',
    naryn: 'Нарын',
    talas: 'Талас',
  };
  return cityMap[m[1]] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
}

// Resolve short 2GIS links (go.2gis.com/XXXXX)
async function resolveShortLink(url) {
  try {
    const resp = await axios.get(url, {
      maxRedirects: 5,
      timeout: 5000,
      validateStatus: s => s < 400,
    });
    return resp.request.res.responseUrl || url;
  } catch {
    return url;
  }
}

// ── Main fetch function ───────────────────────────────────────────────────────

async function fetchPlaceFromLink(rawUrl) {
  // Resolve short links first
  let url = rawUrl.trim();
  if (url.includes('go.2gis.com')) {
    url = await resolveShortLink(url);
  }

  const coords = parseCoords(url);
  if (!coords) {
    throw new Error('Координаты не найдены в ссылке. Убедитесь что это ссылка из 2GIS.');
  }

  const firmId = parseFirmId(url);
  const city   = parseCity(url);
  const apiKey = process.env.TWOGIS_API_KEY;

  // Strategy 1: fetch by firm ID (most accurate)
  if (firmId && apiKey) {
    try {
      const res = await axios.get(`${BASE}/items/byid`, {
        params: { id: firmId, key: apiKey, fields: 'items.address,items.name_ex' },
        timeout: 6000,
      });
      const item = res.data?.result?.items?.[0];
      if (item) {
        return {
          name:   item.name,
          street: item.address?.building_name || item.address?.components
                    ?.filter(c => ['street','building'].includes(c.type))
                    .map(c => c.value).join(', ') || '',
          city,
          lat: coords.lat,
          lng: coords.lng,
        };
      }
    } catch (e) {
      console.warn('2GIS byid failed, falling back to geocode:', e.message);
    }
  }

  // Strategy 2: reverse geocode by coords
  if (apiKey) {
    try {
      const res = await axios.get(`${BASE}/items/geocode`, {
        params: {
          lat: coords.lat,
          lon: coords.lng,
          key: apiKey,
          fields: 'items.address,items.name',
          radius: 50,
        },
        timeout: 6000,
      });
      const item = res.data?.result?.items?.[0];
      if (item) {
        return {
          name:   item.name || 'Торговая точка',
          street: item.address?.name || '',
          city,
          lat: coords.lat,
          lng: coords.lng,
        };
      }
    } catch (e) {
      console.warn('2GIS geocode failed:', e.message);
    }
  }

  // Strategy 3: coords only (no API key or API down)
  return {
    name:   'Торговая точка',
    street: '',
    city,
    lat: coords.lat,
    lng: coords.lng,
    warning: 'Название и адрес не получены — заполните вручную',
  };
}

module.exports = { fetchPlaceFromLink };
