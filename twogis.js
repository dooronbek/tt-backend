// twogis.js - 2GIS link parser + Places API client
const axios = require('axios');

const BASE = 'https://catalog.api.2gis.com/3.0';

// Supported link formats:
// https://2gis.kg/bishkek/geo/70000001077376022/74.592300,42.847205  (with coords)
// https://2gis.kg/bishkek/geo/70000001020224129                       (without coords)
// https://2gis.kg/bishkek/firm/70000001043165232/42.841427,74.637059  (firm link)
// https://go.2gis.com/XXXXX                                           (short link)

// Extract coords from URL if present (lng,lat format)
function parseCoords(url) {
    const m = url.match(/\/(\d{2,3}\.\d+),(\d{2,3}\.\d+)/);
    if (!m) return null;
    // 2GIS format in URL is lng,lat
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
}

// Extract object ID from /geo/ links
function parseGeoId(url) {
    const m = url.match(/\/geo\/(\d+)/);
    return m ? m[1] : null;
}

// Extract firm ID from /firm/ links
function parseFirmId(url) {
    const m = url.match(/\/firm\/(\d+)/);
    return m ? m[1] : null;
}

// Parse city from URL
function parseCity(url) {
    const m = url.match(/2gis\.[a-z]+\/([a-z_-]+)\//);
    if (!m) return 'Bishkek';
    const cityMap = {
          bishkek: 'Бишкек', osh: 'Ош', jalal_abad: 'Джалал-Абад',
          karakol: 'Каракол', tokmok: 'Токмок', balykchy: 'Балыкчы',
          naryn: 'Нарын', talas: 'Талас',
    };
    return cityMap[m[1]] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
}

// Resolve short links (go.2gis.com/XXXXX)
async function resolveShortLink(url) {
    try {
          const resp = await axios.get(url, {
                  maxRedirects: 5, timeout: 5000,
                  validateStatus: s => s < 400,
          });
          return resp.request?.res?.responseUrl || resp.config?.url || url;
    } catch (e) {
          return url;
    }
}

// Main function
async function fetchPlaceFromLink(rawUrl) {
    let url = rawUrl.trim();

  // Resolve short links first
  if (url.includes('go.2gis.com')) {
        url = await resolveShortLink(url);
  }

  const apiKey = process.env.TWOGIS_API_KEY;
    const city   = parseCity(url);

  // Get object ID - try /geo/ first, then /firm/
  const objectId = parseGeoId(url) || parseFirmId(url);

  // Strategy 1: fetch by object ID via items/byid (works for both /geo/ and /firm/ links)
  if (objectId && apiKey) {
        try {
                const res = await axios.get(`${BASE}/items/byid`, {
                          params: { id: objectId, key: apiKey, fields: 'items.address,items.name_ex,items.point' },
                          timeout: 6000,
                });
                const item = res.data?.result?.items?.[0];
                if (item) {
                          const point = item.point;
                          return {
                                      name:   item.name,
                                      street: item.address?.building_name || item.address?.components
                                        ?.filter(c => ['street', 'building'].includes(c.type))
                                        .map(c => c.value).join(', ') || '',
                                      city,
                                      lat: point ? point.lat : null,
                                      lng: point ? point.lon : null,
                          };
                }
        } catch (e) {
                console.warn('2GIS byid failed:', e.message);
        }
  }

  // Strategy 2: fall back to geocode using coords from URL (Type 1 links only)
  const coords = parseCoords(url);
    if (coords && apiKey) {
          try {
                  const res = await axios.get(`${BASE}/items/geocode`, {
                            params: { lat: coords.lat, lon: coords.lng, key: apiKey,
                                               fields: 'items.address,items.name', radius: 50 },
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

  // Strategy 3: coords only, no name
  if (coords) {
        return { name: 'Торговая точка', street: '', city, lat: coords.lat, lng: coords.lng };
  }

  throw new Error('Не удалось получить данные из ссылки 2GIS. Проверьте ссылку.');
}

module.exports = { fetchPlaceFromLink };
