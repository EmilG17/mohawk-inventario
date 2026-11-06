/**
 * Netlify Function / Vercel Serverless Function: Proxy CORS para UPCitemdb.
 *
 * La API pública de UPCitemdb tiene restricción de CORS para llamadas desde el navegador.
 * Si publicas la app en Netlify, esta función se activa automáticamente en /api/upc
 * (gracias a netlify.toml) y permite que el teléfono consulte la base de datos de UPCs.
 */
export async function handler(event) {
  const upc = (event.queryStringParameters?.upc || '').trim();
  if (!upc) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Parámetro upc requerido' }),
    };
  }

  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mohawk-Inventory-PWA/1.0',
      },
    });
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Error conectando con UPCitemdb: ' + err.message }),
    };
  }
}
