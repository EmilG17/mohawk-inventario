/**
 * Netlify Function / Vercel Serverless Function: Proxy CORS para UPCitemdb.
 *
 * La API pública de UPCitemdb tiene restricción de CORS para llamadas desde el navegador.
 * Si publicas la app en Netlify, esta función se activa automáticamente en /api/upc
 * (gracias a netlify.toml) y permite que el teléfono consulte la base de datos de UPCs.
 */
export async function handler(event) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const upc = (event.queryStringParameters?.upc || '').trim();
  if (!upc) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing required upc parameter' }),
    };
  }
  if (!/^[A-Za-z0-9\-]{4,32}$/.test(upc)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Invalid barcode format' }),
    };
  }

  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mohawk-Inventory-PWA/1.0',
      },
    });
    const body = await res.text();
    const headers = { ...corsHeaders };
    if (res.status === 200) {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    return {
      statusCode: res.status,
      headers,
      body,
    };
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    return {
      statusCode: isAbort ? 504 : 502,
      headers: corsHeaders,
      body: JSON.stringify({
        error: isAbort ? 'Upstream lookup timed out' : 'Upstream lookup service unavailable',
      }),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
