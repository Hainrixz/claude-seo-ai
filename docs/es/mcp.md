# MCP y niveles de datos

claude-seo-ai está diseñado para funcionar con **cero servidores MCP y cero claves de API**. Todo lo que vaya más allá de eso es opcional (opt-in). Cuando un nivel superior no está disponible, los hallazgos se degradan a `needs_api` de forma honesta: la herramienta nunca fabrica un valor medido ni devuelve un `pass` falso.

## Los tres niveles de datos

| Nivel | Requiere | Habilita | Si no está disponible |
|---|---|---|---|
| **0 — sin conexión (predeterminado)** | Nada — `WebFetch` + los scripts incluidos | Auditoría de HTML en bruto: cadena de estado/redirecciones, cabeceras, `robots.txt`, sitemaps, `llms.txt` y heurísticas de laboratorio | Este es el mínimo — siempre disponible |
| **1 — renderizado + CWV de campo** | Un MCP de renderizado (Playwright/Firecrawl) o una clave de API de PageSpeed | DOM renderizado para páginas SPA/CSR; Core Web Vitals reales de campo (CrUX p75) mediante `scripts/psi-client.mjs` | Los hallazgos dependientes del renderizado y de los CWV de campo → `needs_api` |
| **2 — autenticado** | MCP con OAuth de Search Console / Merchant (lo añades tú mismo) | Datos reales de consultas/cobertura/merchant | Los hallazgos de nivel 2 → `needs_api` |

La skill `seo-crawl-render` construye un único `PageSnapshot` compartido y registra el `tier` que realmente alcanzó. Las skills posteriores anotan cualquier hallazgo como `needs_api` cuando requiere un nivel superior al que se alcanzó.

## Nivel 0 — qué funciona sin configuración

Construir el `PageSnapshot` una sola vez es lo que hace posible la auditoría sin conexión. En el nivel 0, el rastreador obtiene la página únicamente con `WebFetch` (`rendered_dom = null`) y aun así obtienes:

- La cadena de estado y de redirecciones, las cabeceras de la respuesta final (incl. `X-Robots-Tag`, content-type, `Link` de hreflang).
- `robots.txt`, los sitemaps referenciados y `/llms.txt`.
- El HTML en bruto, previo a JS, que el rastreador y los bots de IA ven primero.
- **Heurísticas de laboratorio** para Core Web Vitals: recuento de recursos que bloquean el renderizado, imágenes sin dimensiones (riesgo de CLS), bundles grandes (riesgo de INP/LCP). Estas se etiquetan claramente como **"datos de laboratorio — no es por lo que Google posiciona"** y nunca determinan por sí solas la puntuación de Search.

Para una página solo CSR sin MCP de renderizado, el snapshot mantiene `rendered_dom = null`, establece `render.confidence = reduced` y emite un hallazgo que indica que la página se auditó a partir del HTML en bruto — nunca finge haber visto contenido renderizado que no vio.

## Nivel 1a — activar un MCP de renderizado

Los MCP de renderizado son **opcionales** y **nunca los iniciamos automáticamente**. Activar el plugin nunca fuerza una descarga ni una solicitud de credenciales. Para habilitar el renderizado de JavaScript en sitios SPA/CSR, copia la entrada correspondiente de [`.mcp.json.example`](../../.mcp.json.example) a tu `.mcp.json` del proyecto (o a `mcpServers` en `~/.claude.json`) y apruébala:

```jsonc
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "firecrawl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" }
    }
  }
}
```

Cuando se necesita un renderizado **y** hay un MCP de renderizado disponible, el rastreador lo descubre mediante la búsqueda de herramientas, captura el `rendered_dom` y establece `render.confidence = high`. Solo necesitas uno de los dos; Firecrawl, además, necesita `FIRECRAWL_API_KEY` en tu entorno.

## Nivel 1b — Core Web Vitals reales mediante `PSI_API_KEY`

Los CWV de campo (los datos CrUX p75 por los que Google realmente posiciona) provienen de `scripts/psi-client.mjs`, que llama a la API de Google PageSpeed Insights. La clave es **opcional pero recomendada**: sin clave o sin red, el cliente devuelve `status: "needs_api"` en lugar de adivinar.

Establece la clave una vez en tu entorno:

```bash
export PSI_API_KEY="<your-free-pagespeed-key>"
```

Después ejecuta el cliente (lee `PSI_API_KEY` del entorno si se omite `--key`):

```bash
node scripts/psi-client.mjs --url https://example.com
node scripts/psi-client.mjs --url https://example.com --strategy desktop
node scripts/psi-client.mjs --url https://example.com --key "$PSI_API_KEY"
```

Banderas: `--url` (obligatoria), `--strategy mobile|desktop` (por defecto `mobile`), `--key` (sobrescribe la variable de entorno). Informa de las métricas de campo evaluadas frente a los umbrales p75, con los datos de laboratorio devueltos por separado y marcados explícitamente como **"NO es por lo que Google posiciona."**

Umbrales p75 de campo (`references/cwv-thresholds.md`):

| Métrica | Bueno | Necesita mejorar | Deficiente |
|---|---|---|---|
| **LCP** | ≤ 2.5 s | 2.5–4.0 s | > 4.0 s |
| **INP** (sustituyó a FID) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** | ≤ 0.1 | 0.1–0.25 | > 0.25 |

Las tres deben superar el umbral en p75 para obtener una valoración de "bueno". Sin una clave de PSI, todos los hallazgos de CWV de campo se emiten como `needs_api` (severidad 4, `fixable: advisory`) — nunca como un `pass` falso. Los CWV son un factor de desempate real pero modesto: pesan mucho en la puntuación de Search y mínimamente en la puntuación de Visibilidad en IA, así que no esperes que una puntuación verde anule la relevancia o la calidad del contenido.

## Nivel 2 — OAuth de Search Console / Merchant

El nivel 2 cubre fuentes de datos autenticadas (Search Console, Merchant) detrás de OAuth. Estos son **MCP independientes que añades tú mismo** — no vienen incluidos ni figuran en `.mcp.json.example`. Hasta que conectes uno, cualquier hallazgo que necesite datos de consultas, cobertura o merchant se degrada a `needs_api`.

## Degradación elegante, en resumen

- **El nivel 0 siempre basta para ejecutar una auditoría.** No requiere ningún MCP, ninguna clave ni OAuth en red.
- Sin MCP de renderizado → las páginas CSR se auditan a partir del HTML en bruto, `render.confidence = reduced`, con un hallazgo que te indica que instales Playwright/Firecrawl para una cobertura completa.
- Sin clave de PSI → los CWV de campo se informan como `needs_api`, acompañados únicamente de heurísticas de laboratorio claramente etiquetadas.
- Sin MCP de nivel 2 → los hallazgos autenticados se informan como `needs_api`.
- Cuando el nivel requerido no está disponible, el estado es **`needs_api`** — nunca una métrica fabricada ni un `pass` falso.
