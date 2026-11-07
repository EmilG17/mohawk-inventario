/**
 * Parser e importador de archivos de formato BarTender (.btw) y archivos de comandos
 * de impresoras térmicas Intermec / Honeywell / Zebra (.prn, .ipl, .fp, .zpl, .xml, .txt).
 *
 * Los archivos .btw de BarTender son contenedores OLE2 / Compound File Binary (o XML comprimido
 * en versiones recientes) que almacenan en texto UTF-16LE y UTF-8 los nombres de las fuentes,
 * dimensiones de página, simbologías y campos de texto/datos.
 */

export interface BartenderFormatProfile {
  fileName: string;
  labelWidthIn: number;
  labelHeightIn: number;
  dpi: number;
  barHeightPx: number;
  moduleWidthPx: number;
  fontSizePt: number;
  topMarginIn: number;
  leftMarginIn: number;
  rightMarginIn: number;
  includeHumanReadable: boolean;
  includeFooter: boolean;
  detectedFonts: string[];
  detectedTexts: string[];
  summary: string;
}

const STORAGE_KEY = 'mohawk_bartender_profile';

export const DEFAULT_BARTENDER_PROFILE: BartenderFormatProfile = {
  fileName: 'BarTender Estándar Mohawk (3.97" × 6" · 203 DPI)',
  labelWidthIn: 3.97,
  labelHeightIn: 6.0,
  dpi: 203,
  barHeightPx: 32,
  moduleWidthPx: 2.2,
  fontSizePt: 11.5,
  topMarginIn: 0.42,
  leftMarginIn: 0.25,
  rightMarginIn: 0.25,
  includeHumanReadable: true,
  includeFooter: false,
  detectedFonts: ['Arial', 'Monospace'],
  detectedTexts: [],
  summary: 'Formato BarTender compacto superior (3.97" × 6", 203 DPI)',
};

/**
 * Extrae cadenas legibles ASCII y UTF-16LE de un buffer binario (.btw / .prn).
 */
export function extractStringsFromBinary(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer);
  const results = new Set<string>();

  // 1. Extraer cadenas ASCII / UTF-8 de al menos 4 caracteres imprimibles
  let currentAscii = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 32 && b <= 126) {
      currentAscii += String.fromCharCode(b);
    } else {
      if (currentAscii.trim().length >= 4) {
        results.add(currentAscii.trim());
      }
      currentAscii = '';
    }
  }
  if (currentAscii.trim().length >= 4) {
    results.add(currentAscii.trim());
  }

  // 2. Extraer cadenas UTF-16LE (en offsets pares e impares por si cambia el alineamiento en buffers)
  for (const offset of [0, 1]) {
    let currentUtf16 = '';
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      const low = bytes[i];
      const high = bytes[i + 1];
      if (high === 0 && low >= 32 && low <= 126) {
        currentUtf16 += String.fromCharCode(low);
      } else {
        if (currentUtf16.trim().length >= 4) {
          results.add(currentUtf16.trim());
        }
        currentUtf16 = '';
      }
    }
    if (currentUtf16.trim().length >= 4) {
      results.add(currentUtf16.trim());
    }
  }

  return Array.from(results);
}

/**
 * Analiza un archivo .btw, .prn, .zpl, .ipl o .xml y construye un perfil de formato BarTender.
 */
export async function parseBartenderFile(file: File): Promise<BartenderFormatProfile> {
  const buffer = await file.arrayBuffer();
  return parseBartenderBuffer(buffer, file.name);
}

export function parseBartenderBuffer(
  buffer: ArrayBuffer,
  fileName = 'formato.btw',
): BartenderFormatProfile {
  const strings = extractStringsFromBinary(buffer);
  const joined = strings.join('\n');

  const profile: BartenderFormatProfile = {
    ...DEFAULT_BARTENDER_PROFILE,
    fileName,
    detectedFonts: [],
    detectedTexts: [],
  };

  // Detectar fuentes comunes en archivos BarTender
  const fontRegex = /\b(Arial|Calibri|Helvetica|Tahoma|Verdana|Courier New|Consolas|Swiss 721|OCR-B|Intermec|Andale Mono|Times New Roman)\b/gi;
  const fontsFound = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = fontRegex.exec(joined)) !== null) {
    fontsFound.add(match[1]);
  }
  profile.detectedFonts = fontsFound.size > 0 ? Array.from(fontsFound) : ['Arial'];

  // Detectar si menciona Intermec PM43 o DPI
  if (/\b300\s*dpi\b/i.test(joined)) {
    profile.dpi = 300;
  } else if (/\b203\s*dpi\b/i.test(joined) || /PM43/i.test(joined) || /Intermec/i.test(joined)) {
    profile.dpi = 203;
  }

  // Detectar dimensiones en comandos ZPL (^PW, ^LL) o IPL o XML
  const pwMatch = joined.match(/\^PW(\d{3,4})/);
  const llMatch = joined.match(/\^LL(\d{3,4})/);
  if (pwMatch) {
    const pwDots = parseInt(pwMatch[1], 10);
    if (pwDots >= 200 && pwDots <= 2400) {
      profile.labelWidthIn = Number((pwDots / profile.dpi).toFixed(2));
    }
  }
  if (llMatch) {
    const llDots = parseInt(llMatch[1], 10);
    if (llDots >= 200 && llDots <= 3600) {
      profile.labelHeightIn = Number((llDots / profile.dpi).toFixed(2));
    }
  }

  // Detectar si hay menciones a 3.97 o 4x6
  if (/3\.97/.test(joined)) {
    profile.labelWidthIn = 3.97;
    profile.labelHeightIn = 6.0;
  }

  // Filtrar textos descriptivos útiles dentro del archivo .btw
  const ignorePatterns = /^(Bartender|Seagull|Version|Format|Printer|Intermec|Honeywell|Microsoft|Windows|Arial|Calibri|TrueType|Code\s*128|Standard|Normal|Default|Object|Barcode|Text|Line|Box|root|stream|xml|http)/i;
  const candidateTexts = strings.filter(
    (s) =>
      s.length >= 4 &&
      s.length <= 60 &&
      /[A-Za-z0-9]/.test(s) &&
      !ignorePatterns.test(s) &&
      !/^[\W_]+$/.test(s),
  );
  profile.detectedTexts = candidateTexts.slice(0, 12);

  // Si el nombre del archivo o contenido sugiere incluir pie de página (SKU / Unidad)
  if (/completo|sku|full|footer|detalle/i.test(fileName)) {
    profile.includeFooter = true;
  }

  profile.summary = `${fileName} (${profile.labelWidthIn}" × ${profile.labelHeightIn}", ${profile.dpi} DPI · Barra ${profile.barHeightPx}px · Fuente ${profile.fontSizePt}pt)`;
  return profile;
}

let memoryProfile: BartenderFormatProfile | null = null;

export function getSavedBartenderProfile(): BartenderFormatProfile {
  if (memoryProfile !== null) {
    return { ...memoryProfile };
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<BartenderFormatProfile>;
        const merged: BartenderFormatProfile = {
          ...DEFAULT_BARTENDER_PROFILE,
          ...parsed,
        };
        memoryProfile = merged;
        return { ...merged };
      }
    } catch {
      // Fallback a memoria
    }
  }
  return { ...DEFAULT_BARTENDER_PROFILE };
}

export function saveBartenderProfile(profile: Partial<BartenderFormatProfile>): BartenderFormatProfile {
  const current = getSavedBartenderProfile();
  const updated: BartenderFormatProfile = {
    ...current,
    ...profile,
  };
  updated.summary = `${updated.fileName} (${updated.labelWidthIn}" × ${updated.labelHeightIn}", ${updated.dpi} DPI · Barra ${updated.barHeightPx}px · Fuente ${updated.fontSizePt}pt)`;
  memoryProfile = { ...updated };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  }
  return { ...updated };
}

export function resetBartenderProfile(): BartenderFormatProfile {
  memoryProfile = null;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  return { ...DEFAULT_BARTENDER_PROFILE };
}
