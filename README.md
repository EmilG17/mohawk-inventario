# Inventario Mohawk – Consumibles

Aplicación web instalable (PWA) diseñada para agilizar el conteo físico de consumibles en planta desde cualquier teléfono móvil (Android o iPhone), escaneando códigos de barras con la cámara o un lector Bluetooth, funcionando **sin internet** y exportando resultados a Excel y CSV.

---

## Características principales

- **Escaneo por cámara:** lee códigos 1D (UPC-A, EAN-13, Code 128, Code 39, ITF) y 2D (QR, DataMatrix). Linterna integrada, pitido y vibración al detectar.
- **Obtención automática de descripciones:**
  1. Catálogo local importado desde Excel/CSV (instantáneo y offline).
  2. Consulta automática en internet (Open Products Facts y UPCitemdb) si el código no está en catálogo.
  3. Captura manual rápida si no se encuentra o no hay red, con reintento automático al recuperar conexión.
- **100% Offline (PWA):** una vez abierta por primera vez, todos los assets y datos se guardan en el teléfono (IndexedDB). No depende de conexión en el piso de planta.
- **Varios usuarios sin servidor:**
  - Cada contador registra en su propio teléfono con su nombre.
  - Cada quien exporta su archivo de conteo (`.json`).
  - El supervisor importa los archivos en su teléfono o PC; el sistema suma las cantidades por código de barras sin duplicar registros.
- **Comparación con existencias teóricas:**
  - Resumen de exactitud (% de productos correctos).
  - Identificación automática de faltantes, sobrantes, productos no contados y no catalogados.
  - Diferencias valorizadas con el costo unitario del catálogo.
- **Exportación completa:**
  - Libro Excel (`.xlsx`) con 5 hojas: **Resumen**, **Conteo completo**, **Diferencias**, **No catalogados** y **Detalle de escaneos**.
  - Archivo CSV con codificación UTF-8 BOM para apertura directa en Excel.

---

## Formato sugerido para el catálogo de Mohawk

Puedes importar cualquier archivo `.xlsx`, `.xls` o `.csv`. El asistente detectará las columnas automáticamente. Se recomiendan estas columnas:

| Columna | Obligatoria | Descripción / Ejemplo |
|---|---|---|
| `Código de barras` | Sí (o SKU) | UPC/EAN del proveedor (ej. `079567011003`). Se conservan ceros iniciales. |
| `No. de parte` | Opcional | Número de parte interno de Mohawk (ej. `MHK-LUB-010`). |
| `Descripción` | Sí | Nombre del producto (ej. `Lubricante multiusos WD-40 11 oz`). |
| `Unidad` | Opcional | Unidad de medida (ej. `PZA`, `CJA`, `GAL`, `RLO`). |
| `Existencia teórica` | Opcional | Cantidad en sistema antes de iniciar el inventario. |
| `Costo unitario` | Opcional | Para valorizar diferencias en pesos o dólares. |

Un archivo de ejemplo listo para probar se encuentra en:
- `sample/catalogo_consumibles_mohawk.xlsx`
- `sample/catalogo_consumibles_mohawk.csv`

---

## Publicación (Cómo ponerlo en el teléfono)

> **Requisito indispensable para la cámara:** Los navegadores exigen que la página se sirva bajo **`https://`** (o `localhost`).

La aplicación se compila como archivos estáticos (`dist/`). Opciones para publicarla:

### Opción A: Netlify (Recomendada con proxy de UPCitemdb)
1. Arrastra la carpeta del proyecto a [app.netlify.com/drop](https://app.netlify.com/drop) o conecta el repositorio.
2. Netlify detecta automáticamente el archivo `netlify.toml`, compila con `npm run build` y habilita la función serverless `/api/upc` para búsquedas en UPCitemdb.
3. Te dará una URL segura `https://tu-sitio.netlify.app`.

### Opción B: GitHub Pages
1. Ejecuta `npm run build`.
2. Sube el contenido de la carpeta `dist/` a la rama `gh-pages` de tu repositorio.
3. Tu app estará en `https://<usuario>.github.io/<repo>/`.

### Opción C: Servidor interno de Mohawk
1. Copia la carpeta `dist/` a cualquier servidor web interno (Nginx, Apache, IIS).
2. Asegúrate de configurar un certificado SSL válido (`https://inventario.mohawk.local/`).

---

## Instalación en el teléfono

Una vez abierta la URL en el navegador del teléfono:

- **Android (Chrome):**
  Aparecerá un aviso o botón **"Instalar app"**. También puedes tocar el menú `⋮` y seleccionar **"Instalar aplicación"** o **"Agregar a pantalla principal"**.
- **iPhone (Safari):**
  Toca el botón **Compartir** (icono de cuadro con flecha hacia arriba) y selecciona **"Agregar a pantalla de inicio"** (Add to Home Screen).

Una vez instalada, la app tiene su propio icono en el inicio, abre a pantalla completa sin barras de navegador y funciona aunque desactives el Wi-Fi y los datos móviles.

---

## Flujo de trabajo en inventario

```
[1. Preparación]
  Supervisor importa catálogo Excel/CSV en su teléfono o PC.
  Exporta el archivo de catálogo (Catálogo → Compartir) y lo manda por WhatsApp al equipo.

[2. Conteo en piso de planta]
  Cada contador abre la app en su teléfono, pone su nombre e importa el catálogo.
  Van a "Contar", activan la cámara y escanean los consumibles.
  - Modo cantidad: escanean, ajustan la cantidad y tocan "Registrar".
  - Modo rápido (+1): cada escaneo suma 1 automáticamente.
  - Si un producto no tiene código, se busca por SKU o descripción en el buscador superior.
  - Si un producto no está catalogado, se registra como "No catalogado" y la app busca su nombre en internet.

[3. Consolidación]
  Cada contador entra a "Equipo" y toca "Compartir mi conteo" (lo envía por WhatsApp o correo al supervisor).
  El supervisor abre su app, entra a "Equipo" y toca "Importar archivos de otros".
  Selecciona todos los archivos recibidos. La app suma los conteos por código sin duplicar escaneos.

[4. Reporte y cierre]
  El supervisor entra a "Reporte", revisa la exactitud y los faltantes/sobrantes.
  Toca "Exportar Excel (.xlsx)" para obtener el reporte formal con desglose por producto y auditoría de escaneos.
```

---

## Comandos de desarrollo

```bash
# Instalar dependencias
npm install

# Modo desarrollo con recarga en vivo
npm run dev

# Compilar para producción (genera carpeta dist/)
npm run build

# Vista previa de producción local
npm run preview

# Ejecutar pruebas unitarias (Vitest)
npm run test

# Ejecutar pruebas E2E en viewport móvil (Playwright)
npm run test:e2e

# Regenerar catálogo Excel de muestra
npm run sample
```

---

## Licencia y créditos
Desarrollado para Mohawk Industries. Utiliza `@zxing/browser`, `idb` y `SheetJS`.
