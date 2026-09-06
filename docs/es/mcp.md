# MCP y niveles de datos

`claude-seo-ai` está diseñado para funcionar con **cero servidores MCP y cero claves de API**. Todo lo
que vaya más allá de eso es opcional (opt-in). Cuando un nivel superior no está disponible, los
hallazgos se degradan a `needs_api` de forma honesta: la herramienta nunca fabrica un valor medido ni
devuelve un `pass` falso.

## Los tres niveles de datos

| Nivel | Requiere | Habilita | Si no está disponible |
|---|---|---|---|
| **0 — por defecto** | Nada. Los scripts de Node sin dependencias incluidos son la capa de adquisición. | Peticiones reales: cadena de estado/redirecciones, cabeceras de respuesta, robots.txt, sitemaps (recursión de índices + gzip), endpoints de descubrimiento para IA, el HTML previo a JS y todas las comprobaciones sobre HTML estático | Este es el mínimo, siempre disponible |
| **1 — DOM renderizado y/o CWV de campo** | Un Chrome/Chromium/Edge/Brave instalado (detectado automáticamente), o `playwright` ya resoluble, o un DOM que hayas capturado tú; y/o `PSI_API_KEY` | El DOM posterior a JS para páginas SPA/CSR; Core Web Vitals reales de campo (CrUX p75) | Los hallazgos dependientes del renderizado anotan `render.confidence = reduced`; los de CWV de campo → `needs_api` |
| **2 — autenticado** | Search Console / Merchant Center (un MCP que añades tú), o una exportación manual de IA generativa de Search Console | Datos de consultas/cobertura/merchant; la importación de impresiones de IA generativa | Los hallazgos de nivel 2 → `needs_api` |

El nivel se **mide, no se declara**: `report.mjs` fija el nivel 1 cuando al menos una página se
renderizó de verdad o se usó PSI de verdad, y el nivel 2 cuando hay presente una importación de Search
Console. Aparece en `report.json` como `tier` y en el resumen de la auditoría.

## Nivel 0 — qué funciona sin ninguna configuración

No hay `WebFetch` en la ruta de adquisición. Dentro de Claude Code, `WebFetch` devuelve un resumen en
markdown hecho por un modelo pequeño —nunca HTML en bruto, cabeceras ni códigos de estado—, así que
`scripts/snapshot.mjs` y `scripts/crawl.mjs` hacen las peticiones con el propio `fetch` de Node. En el
nivel 0 ya obtienes:

- La cadena completa de estado y redirecciones, con los bucles y los truncamientos señalados.
- Las cabeceras de respuesta, incluidas `X-Robots-Tag`, el content-type y la cabecera `Link:`
  analizada (canonical y alternativas hreflang).
- `robots.txt` analizado con las reglas de precedencia REP de Google, más `Content-Signal`, tanto en
  su ubicación global como por grupo.
- Los sitemaps, siguiendo los archivos de índice y gzip.
- Los endpoints de descubrimiento para IA: `/llms.txt`, `/llms-full.txt`, `/agents.md`,
  `/.well-known/ucp`, `/.well-known/ai-catalog.json`, `/sitemap_agentic_discovery.xml`, informados con
  **peso 0**.
- El HTML en bruto, previo a JS, que un rastreador y un obtenedor de IA ven primero, completamente
  analizado.
- Detección de plataforma en cuatro capas, y todas las comprobaciones deterministas que el registro
  puede ejecutar sobre HTML estático.
- **Heurísticas de laboratorio** para Core Web Vitals: recuento de recursos que bloquean el
  renderizado, imágenes sin dimensiones (riesgo de CLS), bundles pesados (riesgo de INP/LCP). Se
  etiquetan claramente como **«datos de laboratorio — no es por lo que Google posiciona»** y nunca
  determinan por sí solas la puntuación de Search.

Para una página solo CSR sin renderizador, el snapshot mantiene `rendered_html_path: null`, fija
`render.confidence = reduced`, registra la pista y emite un hallazgo M4 que indica que la página se
auditó a partir del HTML en bruto. Nunca finge haber visto contenido renderizado.

## Nivel 1a — renderizado

El renderizado es opcional por partida doble: pasas `--render auto` o `--render js` (el valor por
defecto es `static`, así que una ejecución headless nunca abre un navegador) **y** además tiene que
existir ya un renderizador. Este proyecto no instala nada.

`findChrome()` busca, en este orden:

1. `$CLAUDE_SEO_AI_CHROME`, `$CHROME_PATH`, `$PUPPETEER_EXECUTABLE_PATH`
2. `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome`, `msedge`,
   `brave-browser` en el `PATH`
3. una caché de navegadores de Playwright (`$PLAYWRIGHT_BROWSERS_PATH`,
   `~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`, `~/.cache/ms-playwright`)

Si no encuentra ninguno, obtienes la pista textual: *"No Chrome/Chromium/Edge/Brave found. Install
one, set `CLAUDE_SEO_AI_CHROME=<path to the browser binary>`, or pass `--rendered-file <dom.html>`."*

Playwright solo se usa cuando el paquete `playwright` ya resuelve desde el directorio de trabajo o
desde `$CLAUDE_PLUGIN_DATA/node_modules`; en caso contrario obtienes
*"Install with: `npm i -D playwright && npx playwright install chromium` (~150 MB). Or pass
`--rendered-file`."* Nada se descarga en tu nombre.

```bash
node scripts/snapshot.mjs https://example.com --render auto            # detect a browser, render if needed
node scripts/snapshot.mjs https://example.com --render js --renderer chrome
node scripts/audit.mjs   https://example.com --render auto --pages 5
```

### `--rendered-file` — trae tu propio DOM (aquí es donde encaja un MCP de renderizado)

Dentro de los scripts no hay ningún cliente MCP. Si prefieres un MCP de renderizado (Playwright,
Firecrawl) o tu propio script headless, captura el DOM con él y entrega el archivo:

```bash
node scripts/snapshot.mjs https://example.com --url https://example.com --rendered-file ./dom.html
```

El snapshot trata ese archivo como la pasada renderizada: se analiza en `parsed_rendered`, se calcula
el delta de renderizado frente al HTML estático y todas las comprobaciones sensibles al renderizado lo
leen. Este es el puente soportado entre un DOM capturado con MCP y la canalización determinista.

Los MCP de renderizado son **opcionales** y **nunca se inician automáticamente**: activar el plugin
jamás fuerza una descarga ni una solicitud de credenciales. Para añadir uno, copia la entrada
correspondiente de [`.mcp.json.example`](../../.mcp.json.example) a tu `.mcp.json` del proyecto (o a
`mcpServers` en `~/.claude.json`) y apruébala:

```jsonc
{
  "mcpServers": {
    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "firecrawl":  { "type": "stdio", "command": "npx", "args": ["-y", "firecrawl-mcp"],
                    "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" } }
  }
}
```

Solo necesitas uno. Firecrawl, además, necesita `FIRECRAWL_API_KEY` en tu entorno.

## Nivel 1b — Core Web Vitals reales mediante `PSI_API_KEY`

Los CWV de campo —los datos CrUX p75 por los que Google realmente posiciona— provienen de
`scripts/psi-client.mjs`, que llama a la API de PageSpeed Insights. La clave es **opcional**: sin
clave o sin red, el cliente devuelve `status: "needs_api"` en lugar de adivinar.

El cliente lee primero `CLAUDE_PLUGIN_OPTION_PSI_API_KEY` (lo que exporta un `userConfig` del plugin)
y después `PSI_API_KEY`:

```bash
export PSI_API_KEY="<your-free-pagespeed-key>"
node scripts/psi-client.mjs --url https://example.com
node scripts/psi-client.mjs --url https://example.com --strategy desktop
PSI_API_KEY="<key>" node scripts/psi-client.mjs --url https://example.com     # one-off
```

Deliberadamente **no existe ninguna bandera `--key`**, ni aquí ni en `audit.mjs`: un secreto en la
línea de comandos queda en `ps`, en el historial del shell y en cualquier registro de comandos, y
estos scripts imprimen el comando para reproducir la ejecución.

Umbrales p75 de campo ([`references/cwv-thresholds.md`](../../references/cwv-thresholds.md)):

| Métrica | Bueno | Necesita mejorar | Deficiente |
|---|---|---|---|
| **LCP** | ≤ 2.5 s | 2.5–4.0 s | > 4.0 s |
| **INP** (sustituyó a FID) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** | ≤ 0.1 | 0.1–0.25 | > 0.25 |

Las tres deben superar el umbral en p75 para obtener una valoración de «bueno». Sin una clave, todos
los hallazgos de CWV de campo se emiten como `needs_api`, nunca como un `pass` falso. Cuando PSI
recurre a datos de nivel de origen porque la URL tiene poco tráfico, ese `origin_fallback` se muestra
en lugar de presentarse como las cifras propias de la página.

Los CWV son un factor de desempate real pero modesto: pesan mucho en la puntuación de Search y
mínimamente en la de Visibilidad en IA, así que una puntuación verde de CWV no anula la relevancia ni
la calidad del contenido.

## Nivel 2 — Search Console / Merchant Center

El nivel 2 cubre fuentes autenticadas detrás de OAuth. Son **MCP independientes que añades tú**: no
vienen incluidos ni figuran en `.mcp.json.example`. Hasta que conectes uno, cualquier hallazgo que
necesite datos de consultas, cobertura o merchant se degrada a `needs_api`.

La única vía de nivel 2 que funciona sin ningún MCP es la importación **manual** de IA generativa: la
Search Analytics API de Google no expone dimensiones de IA, y ninguna exportación separa las
superficies de IA de la búsqueda ordinaria, así que descargas a mano el informe de **IA generativa**
de Search Console y pasas el CSV:

```bash
node scripts/gsc-ai-import.mjs --csv ./search-console.csv --host example.com \
  > "<run_dir>/probes/gsc-generative-ai.json"
```

Se aceptan cabeceras de columna en inglés y en español (con o sin BOM, comillas o delimitador de punto
y coma). **Las impresiones son la única cifra que se trata como utilizable** —los clics y la posición
no se exponen por superficie de IA— y todos los hallazgos que produce son de **severidad 0**,
excluidos de la puntuación. Redirigirlo al directorio `probes/` de la ejecución es lo que hace que
`report.mjs` lo informe bajo `probes.gsc_generative_ai` en el nivel 2.

## El oráculo opcional de documentación de Shopify

[`.mcp.json.example`](../../.mcp.json.example) incluye también `@shopify/dev-mcp`:

```jsonc
{ "shopify-dev": { "type": "stdio", "command": "npx", "args": ["-y", "@shopify/dev-mcp@latest"] } }
```

Es un **oráculo de documentación y de esquema GraphQL**, no una vía de escritura. Úsalo para responder
«¿existe este campo en esta versión de la API?» antes de escribir en una tienda. Nunca toca tu tienda
ni guarda credenciales, y los adaptadores de Shopify jamás lo requieren: recurren a su constante de
versión de API fijada. No existe ningún MCP oficial de Shopify que escriba.

## Degradación elegante, en resumen

- **El nivel 0 siempre basta para ejecutar una auditoría.** Sin MCP, sin clave, sin OAuth.
- Sin renderizador → las páginas CSR se auditan a partir del HTML en bruto con
  `render.confidence = reduced` y un hallazgo que nombra el renderizador ausente y cómo aportarlo.
- Sin clave de PSI → los CWV de campo son `needs_api`, acompañados únicamente de heurísticas de
  laboratorio claramente etiquetadas.
- Sin fuente de nivel 2 → los hallazgos autenticados son `needs_api`.
- Siempre que el nivel requerido no esté disponible, el estado es **`needs_api`**: nunca una métrica
  fabricada, nunca un `pass` falso y nunca una ausencia silenciosa en el informe.
