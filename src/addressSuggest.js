const STREETS = '9ad3862c-8391-4b2f-84a4-2d4c68625f4b';
const CITIES = '5c78e9fa-c2e2-4771-93ff-7f400a12f7ba';
const ENDPOINT = 'https://data.gov.il/api/3/action/datastore_search';

let cityCache = null;
let cityLoading = null;
const streetLoads = new Map();

function clean(value, max = 60) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function lookup(resource, params) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('resource_id', resource);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error('לא ניתן לאמת את הכתובת כרגע. נסי שוב');
    err.status = 503;
    throw err;
  }
  const data = await res.json();
  if (!data.success) {
    const err = new Error('לא ניתן לאמת את הכתובת כרגע. נסי שוב');
    err.status = 503;
    throw err;
  }
  return data.result || { records: [], total: 0 };
}

async function allCities() {
  if (cityCache) return cityCache;
  if (!cityLoading) {
    cityLoading = (async () => {
      const names = [];
      for (let offset = 0; offset < 5000; offset += 1000) {
        const result = await lookup(CITIES, { limit: '1000', offset: String(offset) });
        const records = result.records || [];
        for (const row of records) {
          const name = clean(row['שם_ישוב']);
          if (name) names.push(name);
        }
        if (records.length < 1000) break;
      }
      cityCache = [...new Set(names)].sort((a, b) => a.localeCompare(b, 'he'));
      return cityCache;
    })().catch((error) => {
      cityLoading = null;
      throw error;
    });
  }
  return cityLoading;
}

export async function suggestCities(rawQuery) {
  const q = clean(rawQuery, 40);
  if (q.length < 1) return [];
  const names = await allCities();
  const starts = [];
  const includes = [];
  for (const name of names) {
    if (name.startsWith(q)) starts.push(name);
    else if (name.includes(q)) includes.push(name);
    if (starts.length >= 8) break;
  }
  return [...starts, ...includes].slice(0, 8);
}

async function streetsInCity(city) {
  if (!streetLoads.has(city)) {
    streetLoads.set(
      city,
      (async () => {
        const names = [];
        for (let offset = 0; offset < 12000; offset += 1000) {
          const result = await lookup(STREETS, {
            filters: JSON.stringify({ שם_ישוב: city }),
            limit: '1000',
            offset: String(offset),
          });
          const records = result.records || [];
          for (const row of records) {
            const street = clean(row['שם_רחוב']);
            if (street) names.push(street);
          }
          if (records.length < 1000) break;
        }
        return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'he'));
      })().catch((error) => {
        streetLoads.delete(city);
        throw error;
      }),
    );
  }
  return streetLoads.get(city);
}

export async function suggestStreets(city, rawStreet) {
  const cityName = clean(city);
  if (!cityName) return [];
  const names = await streetsInCity(cityName);
  const streetQ = clean(rawStreet, 30);
  if (!streetQ) return [];
  const starts = [];
  const includes = [];
  for (const street of names) {
    if (street.startsWith(streetQ)) starts.push(street);
    else if (street.includes(streetQ)) includes.push(street);
    if (starts.length >= 8) break;
  }
  return [...starts, ...includes].slice(0, 8).map((street) => ({ street, city: cityName }));
}

export async function streetExists(street, city) {
  const result = await lookup(STREETS, {
    filters: JSON.stringify({ שם_רחוב: clean(street), שם_ישוב: clean(city) }),
    limit: '1',
  });
  return Number(result.total) > 0;
}
