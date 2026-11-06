import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../sample');
fs.mkdirSync(outDir, { recursive: true });

const SAMPLE_PRODUCTS = [
  { barcode: '071153000108', sku: 'MHK-PPE-001', description: 'Guantes de nitrilo libres de polvo talla M (Caja 100 pzas)', unit: 'CJA', expectedQty: 45, unitCost: 185.0, brand: 'Ansell' },
  { barcode: '071153000115', sku: 'MHK-PPE-002', description: 'Guantes de nitrilo libres de polvo talla L (Caja 100 pzas)', unit: 'CJA', expectedQty: 30, unitCost: 185.0, brand: 'Ansell' },
  { barcode: '079567011003', sku: 'MHK-LUB-010', description: 'Lubricante multiusos WD-40 en aerosol 11 oz', unit: 'PZA', expectedQty: 24, unitCost: 115.5, brand: 'WD-40' },
  { barcode: '051131069008', sku: 'MHK-PKG-020', description: 'Cinta para empaque transparente Scotch 3M 48mm x 50m', unit: 'PZA', expectedQty: 120, unitCost: 32.0, brand: '3M' },
  { barcode: '071641300018', sku: 'MHK-OFF-005', description: 'Marcador permanente Sharpie punta fina color negro', unit: 'PZA', expectedQty: 60, unitCost: 22.5, brand: 'Sharpie' },
  { barcode: '076174100057', sku: 'MHK-CUT-001', description: 'Navaja tipo cutter retráctil industrial Stanley 9mm', unit: 'PZA', expectedQty: 15, unitCost: 75.0, brand: 'Stanley' },
  { barcode: '076174119219', sku: 'MHK-CUT-002', description: 'Repuesto de hojas para cutter Stanley (Tubo 10 pzas)', unit: 'PZA', expectedQty: 40, unitCost: 48.0, brand: 'Stanley' },
  { barcode: '051138765231', sku: 'MHK-PPE-010', description: 'Lentes de seguridad transparentes antiempañantes 3M Virtua', unit: 'PZA', expectedQty: 80, unitCost: 55.0, brand: '3M' },
  { barcode: '051131065208', sku: 'MHK-ABR-003', description: 'Fibra abrasiva verde para limpieza industrial Scotch-Brite 3M', unit: 'PZA', expectedQty: 50, unitCost: 18.0, brand: '3M' },
  { barcode: '7501006559385', sku: 'MHK-CLN-015', description: 'Desengrasante industrial multiusos biodegradable 4 Litros', unit: 'GAL', expectedQty: 12, unitCost: 290.0, brand: 'Quimica Rex' },
  { barcode: '077924036491', sku: 'MHK-PKG-035', description: 'Película estirable stretch film manual calibre 60 18" x 1000 ft', unit: 'RLO', expectedQty: 18, unitCost: 210.0, brand: 'Berry' },
  { barcode: '076308892110', sku: 'MHK-BAT-004', description: 'Pila alcalina industrial AA Energizer caja con 24 pzas', unit: 'CJA', expectedQty: 8, unitCost: 320.0, brand: 'Energizer' },
];

const rows = SAMPLE_PRODUCTS.map((p) => ({
  'Código de barras': p.barcode,
  'No. de parte': p.sku,
  'Descripción': p.description,
  'Unidad': p.unit,
  'Existencia teórica': p.expectedQty,
  'Costo unitario': p.unitCost,
  'Marca': p.brand,
}));

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(rows);

const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
for (let r = range.s.r + 1; r <= range.e.r; r++) {
  const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
  if (cell) { cell.t = 's'; cell.v = String(cell.v); cell.z = '@'; }
}

ws['!cols'] = [
  { wch: 18 }, { wch: 14 }, { wch: 45 }, { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 15 },
];

XLSX.utils.book_append_sheet(wb, ws, 'Consumibles Mohawk');

const xlsxPath = path.join(outDir, 'catalogo_consumibles_mohawk.xlsx');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
fs.writeFileSync(xlsxPath, buf);
console.log(`Excel generado: ${xlsxPath}`);

const csvPath = path.join(outDir, 'catalogo_consumibles_mohawk.csv');
fs.writeFileSync(csvPath, '\ufeff' + XLSX.utils.sheet_to_csv(ws), 'utf-8');
console.log(`CSV generado: ${csvPath}`);
