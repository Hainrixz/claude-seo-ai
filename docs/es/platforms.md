# Plataformas

`claude-seo-ai` audita todos los sitios igual: una capa de adquisición determinista, un registro de
comprobaciones, dos puntuaciones. Lo que cambia según la plataforma es **qué genera ella ya por ti**,
**qué se niega a dejar cambiar** y **si una corrección se puede escribir de vuelta**.

Este documento es el mapa de eso para el usuario. La versión pensada para los agentes es una ficha por
plataforma en [`references/platforms/`](../../references/platforms/), y la versión legible por máquina
es `profile.json`, que `scripts/detect-platform.mjs` escribe en cada ejecución.

## El detector

Se puntúan cuatro capas **independientes**, para que un WordPress headless detrás de Next.js resuelva
como ambos en lugar de que uno oculte al otro:

| Capa | Ids que puede devolver |
|---|---|
| `platform` | `shopify`, `wordpress`, `wix`, `squarespace`, `webflow`, `framer`, `ghost`, `hubspot`, `bigcommerce`, `magento`, `drupal`, `payload` |
| `framework` | `nextjs`, `nuxt`, `astro`, `sveltekit`, `react-router`, `gatsby`, `hugo`, `jekyll`, `eleventy`, `docusaurus`, `static` |
| `plugins` | `woocommerce`, `yoast`, `rankmath`, `aioseo`, `seopress` |
| `hosting` | `vercel`, `netlify`, `github-pages`, `cloudflare-pages`, `cloudflare`, `wpengine`, `shopify` |

Todo se basa en evidencia: cada veredicto lleva las señales que lo produjeron, y una capa con
evidencia insuficiente se **omite en lugar de adivinarse**. Una plataforma desconocida es `null`, no
«probablemente WordPress».

```bash
# From a persisted run (no extra network)
node scripts/detect-platform.mjs --snapshot <run>/pages/<slug>.json

# Live, plus the four opt-in endpoint probes (/wp-json/, /.well-known/ucp, /products.json, /wp-sitemap.xml)
node scripts/detect-platform.mjs --url https://example.com --probe

# From a checked-out project (the only way repo/package signals are consulted)
node scripts/detect-platform.mjs --path ./my-site
```

`--path` es además lo que mejora un veredicto: Payload, por ejemplo, solo es detectable desde el
repositorio — auditado solo por URL, el perfil dice honestamente `nextjs` y se detiene ahí.

## Matriz de soporte

**Estado** es el encabezado de la ficha de conocimiento de cada plataforma: `stable` = la vía de
escritura se ejerció de extremo a extremo y tiene rollback · `beta` = la vía de escritura está
implementada pero poco ejercitada, así que los cambios se quedan en PROPOSED · `instructions-only` =
no existe API de escritura y cada corrección es una ruta de clics para una persona.

**Comprobaciones extra** cuenta los ids de hallazgo condicionales por plataforma que el registro añade
sobre los 119 que son neutrales respecto a la plataforma. Están deliberadamente ausentes de las
tablas de hallazgos por módulo —un id
de WordPress es ruido en una auditoría de Shopify—, así que su índice está en
[`references/routing.md`](../../references/routing.md).

### Capa de plataforma

| Plataforma | Detectada | Comprobaciones extra | Método de aplicación | Vista previa/staging | Credenciales | Estado |
|---|---|---|---|---|---|---|
| **Shopify** | sí | 11 (M1, M2, M5, M7, M17, M20) | `shopify-theme` (Shopify CLI) + `shopify-admin` (Admin GraphQL) | tema → tema **sin publicar**, previsualizado con `?preview_theme_id=`; la Admin API no tiene | `SHOPIFY_STORE`, `SHOPIFY_THEME_TOKEN`, `SHOPIFY_ADMIN_TOKEN` | beta |
| **WordPress** | sí | 10 (M1, M2, M5, M7, M17) | `wordpress-rest` (Application Passwords) o `wordpress-wpcli` (SSH) | ninguna — en vivo al aplicar | `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` · o `WP_SSH` | beta |
| **WooCommerce** | sí (capa de plugins) | vía WordPress | igual que WordPress | ninguna | igual que WordPress | beta |
| **Webflow** | sí | — | `page-api` (Data API v2) | **staging** — las escrituras quedan sin publicar; `publish` es su propia operación | `WEBFLOW_TOKEN`, `WEBFLOW_SITE_ID` | beta |
| **HubSpot** | sí | — | `page-api` (CMS API v3) | **staging** — `PATCH` al borrador, publicación aparte | `HUBSPOT_TOKEN` | beta |
| **Ghost** | sí | — | `page-api` (Admin API) | los borradores siguen siendo borradores (`live_impact: none`); una entrada publicada cambia en vivo | `GHOST_URL`, `GHOST_ADMIN_KEY` | beta |
| **Wix** | sí | — | `page-api` (Item SEO Tags) | ninguna en la que puedas confiar — las páginas estáticas necesitan `publish: true`, los ítems dinámicos se aplican de inmediato | `WIX_API_KEY`, `WIX_SITE_ID` | beta |
| **BigCommerce** | sí | — | `page-api` (Catalog/Content API) | ninguna para los campos de catálogo — en vivo al escribir | `BIGCOMMERCE_STORE_HASH`, `BIGCOMMERCE_TOKEN` | beta |
| **Payload** | solo repositorio | — | `local-files` para las rutas de Next.js; los campos del documento **no se escriben** | borradores cuando la colección los habilita | — | beta |
| **Squarespace** | sí | — | `instructions` | el propio flujo de borrador/publicación del usuario | ninguna | instructions-only |
| **Framer** | sí | — | `instructions` | el propio flujo de publicación del usuario | ninguna | instructions-only |
| **Magento** | sí | — | `instructions` (+ `local-files` con un checkout) | vaciado de caché / despliegue de contenido estático del operador | ninguna | instructions-only |
| **Drupal** | sí | — | `instructions` (+ `local-files` con un checkout) | revisión + reconstrucción de caché del operador | ninguna | instructions-only |

### Capa de framework (correcciones en el árbol de código)

Todos los frameworks de abajo se corrigen igual: `local-files` edita el **código fuente**, sin
credenciales, y nada llega a producción hasta que el usuario (o CI) despliega. Sin `--project <dir>`
no hay árbol de código que editar, así que el perfil ofrece `instructions` en su lugar.

| Framework | Detectado | Comprobaciones extra | Método de aplicación | Vista previa/staging | Credenciales | Estado |
|---|---|---|---|---|---|---|
| **Next.js** | sí | 3 (`M1.nextjs.robots_conflict`, `M7.nextjs.metadata_base_missing`, `M17.nextjs.sitemap_missing_source`) | `local-files` | ninguna — es una edición de archivo; el despliegue la publica | — | beta |
| **Nuxt** | sí | 1 (`M17.nuxt.site_url_missing`) | `local-files` | ninguna | — | beta |
| **Astro** | sí | 1 (`M17.astro.site_missing`) | `local-files` | ninguna | — | beta |
| **Gatsby** | sí | 2 (`M17.gatsby.site_url_missing`, `M7.gatsby.head_in_non_page`) | `local-files` | ninguna | — | beta |
| **Hugo** | sí | 1 (`M17.hugo.baseurl_missing`) | `local-files` | ninguna | — | beta |
| **Jekyll** | sí | 1 (`M7.jekyll.seo_tag_present`) | `local-files` | ninguna | — | beta |
| **React Router** | sí | 1 (`M7.react_router.meta_replaces_parent`) | `local-files` | ninguna | — | beta |
| **SvelteKit** | sí | — | `local-files` | ninguna | — | beta |
| **Eleventy** | sí | — | `local-files` | ninguna | — | beta |
| **Docusaurus** | sí | — | `local-files` | ninguna | — | beta |
| **HTML estático** | sí | 1 (`M22.static.not_checkable`) | `local-files` (`/<path>/` → `<root>/<path>/index.html`) | ninguna | — | **stable** |

Todo lo que el detector no logre nombrar recibe igualmente una auditoría completa. Simplemente enruta
cada corrección a `instructions`, que es un resultado real —el fragmento exacto y el archivo o panel
al que pertenece—, no un fallo.

## Qué nunca se publica en vivo por defecto

Esta es la promesa que el flujo de corrección cumple en todas las plataformas, y la aplican los
adaptadores, no la prosa:

- **La postura es el dry-run.** `fix` ejecuta `capabilities`, `plan`, `preview` y `verify`, todas de
  solo lectura. `apply`, `publish` y `rollback` pertenecen al único subagente escritor y cada una
  necesita un ticket de confirmación emitido en el mismo turno que tu «sí».
- **Shopify** sube a un tema **sin publicar** (un único tema de staging reutilizable
  `claude-seo-ai <date>`; las tiendas tienen un límite de 20 temas, así que se reutiliza y así se
  dice). Un `shopify theme push` con una bandera de publicación en vivo (`--allow-live`, `--live`,
  `--publish`, `-a`, `-l`, `-p`) es un **rechazo duro** en el hook `guard-bash`: ningún ticket lo
  desbloquea. Publicar es una operación aparte con su propia segunda confirmación, y registra primero
  `previous_live_id` para que un rollback pueda republicar el tema anterior.
- Las escrituras de **Webflow** aterrizan en el estado sin publicar del proyecto; `publish` es una
  operación aparte con ticket. `verify` sobre un cambio en staging dice *«guardado, no publicado»* en
  lugar de afirmar que la página está corregida.
- **HubSpot** aplica el `PATCH` al **borrador** de la página; publicar es su propia operación.
  `--live` cambia al patch directo y la previsualización lo dice antes de preguntarte.
- **Ghost** nunca envía `status`, `html`, `lexical` ni el título de la entrada: cambiar metadatos no
  debe publicar un borrador ni tocar el cuerpo. Actualizar un borrador es `live_impact: none`.
- **WordPress** nunca toca `status` ni el contenido de las entradas; solo campos SEO y opciones.
- **Wix** y **BigCommerce** no tienen una superficie de staging fiable, así que sus cambios se
  etiquetan **`[LIVE]`** en la previsualización y se te dice antes de que confirmes, no después.
- Los **archivos locales** se respaldan byte a byte en `<DATA>/backups/<run-id>/<relpath>` antes de la
  primera modificación, y dentro de Claude Code el escritor aplica el diff con Edit/Write para que
  obtengas la confirmación de diff nativa y el hook `guard-write`. El `apply` propio del adaptador
  existe para ejecuciones con `--yes`/CI y rechaza cualquier ruta que se escape de `--project`.

Cada cambio lleva un `live_impact` de `none` (un archivo o un tema en staging), `staged` (escrito en
una superficie de borrador, invisible para las visitas) o `live` (visible de inmediato), y la
previsualización lo etiqueta `[none]` / `[staged]` / `[LIVE]`. Una confirmación que no nombra el
impacto no es una confirmación válida.

## Credenciales

Las credenciales viven **solo en el entorno**. Nunca aparecen en `argv`, nunca en el log de
correcciones de solo-anexado (allí los comandos se redactan) y nunca en un archivo dentro de tu
repositorio. Una clave ausente se nombra por su nombre de clave: la herramienta te pide que la
configures, nunca que pegues un valor en el chat.

Dos formas de aportarlas:

1. **`/plugin`** → claude-seo-ai → los campos de `userConfig` del plugin. Claude Code exporta cada uno
   como `CLAUDE_PLUGIN_OPTION_<KEY>`, que los adaptadores leen primero.
2. **Tu shell**, antes de iniciar Claude Code: `export SHOPIFY_ADMIN_TOKEN=…`. Los adaptadores
   recurren al nombre `<KEY>` a secas.

Algunas grafías más largas de una build anterior (`WORDPRESS_URL`, `SHOPIFY_CLI_THEME_TOKEN`,
`GHOST_ADMIN_API_KEY`, `HUBSPOT_ACCESS_TOKEN`, `BIGCOMMERCE_ACCESS_TOKEN`, …) siguen resolviéndose
como alias; el nombre del catálogo de arriba tiene prioridad.

Una clave ausente **degrada ese destino a `instructions`**. Nunca hace fallar la ejecución y nunca se
elimina en silencio del resumen del plan.

### Shopify — app personalizada + Theme Access

Dos credenciales separadas, porque son dos vías de escritura separadas. Crea ambas en tu admin de
Shopify; la ruta de menú vigente del proveedor está en la propia documentación de Shopify, y lo que
importa aquí son los valores.

1. **Admin API** — una **app personalizada** cuyo token de acceso a la Admin API va en
   `SHOPIFY_ADMIN_TOKEN`. Se envía como cabecera `X-Shopify-Access-Token` contra
   `https://<store>/admin/api/2026-07/graphql.json`. Alcances: `write_products` para el SEO de
   productos y colecciones, `write_online_store_navigation` para `urlRedirectCreate`. Los alcances de
   páginas y artículos están **SIN VERIFICAR** en esta build (mira la tabla del final).
2. **Theme Access** — una contraseña de **Theme Access** para el tema con el que quieras trabajar. Ese
   valor es `SHOPIFY_THEME_TOKEN`; llega al Shopify CLI a través del entorno del proceso hijo como
   `SHOPIFY_CLI_THEME_TOKEN`, nunca por línea de comandos.
3. `SHOPIFY_STORE` es el dominio `my-store.myshopify.com` (también se exporta al CLI como
   `SHOPIFY_FLAG_STORE`).

El CLI `shopify` debe estar en el `PATH` para el adaptador de temas. El login interactivo de `shopify`
no se puede completar dentro de un subagente: usa un token de Theme Access, o inicia sesión tú en el
shell que arranca Claude Code.

> No existe ningún MCP oficial de Shopify que escriba.
> [`@shopify/dev-mcp`](../../.mcp.json.example) es un oráculo de documentación y esquema: úsalo para
> confirmar que un campo existe en la versión de API fijada, nunca como vía de escritura. Los
> adaptadores no lo requieren.

### WordPress — contraseñas de aplicación

Admin de WordPress → **Usuarios → Perfil → Contraseñas de aplicación** → ponle un nombre → generar.
Los espacios del valor generado se conservan; nunca es la contraseña de tu cuenta.

```bash
export WP_URL="https://example.com"     # https only — Basic auth over http puts the password on the wire
export WP_USER="editor-account"
export WP_APP_PASSWORD="abcd efgh ijkl mnop qrst uvwx"
```

Algunos hostings desactivan por completo las contraseñas de aplicación. Eso es un `needs_api`, no una
falta de insistencia: configura en su lugar `WP_SSH="user@host:/path/to/wordpress"` y el adaptador
`wordpress-wpcli` toma el relevo (necesita `wp` y `ssh` en el `PATH`; cada comando se imprime antes de
ejecutarse).

### Webflow

Un **token de API de sitio** con el alcance `pages:write`, usado contra la Data API v2
(`PUT /v2/pages/{page_id}`).

```bash
export WEBFLOW_TOKEN="…"          # sent as a Bearer token
export WEBFLOW_SITE_ID="…"        # also readable from the page markup as data-wf-site
```

Los ids de página salen del listado de páginas del sitio, no de la URL.

### Wix

Una **clave de API** con los permisos para las etiquetas SEO de ítems, más el id del sitio.

```bash
export WIX_API_KEY="…"            # sent as the Authorization header
export WIX_SITE_ID="…"            # sent as the wix-site-id header
```

Dos particularidades de Wix que conviene conocer antes de confirmar nada: **las etiquetas se
reemplazan por completo**, así que cada escritura es leer → fusionar → escribir el conjunto entero (un
payload parcial borra las etiquetas que omite, y el conjunto capturado *es* el rollback); y el tipo y
el id del ítem no se pueden derivar de una URL, así que vienen de `--answers`:

```json
{"resources": {"https://site/page": {"itemType": "STATIC_PAGE", "itemId": "…"}}}
```

Cuando faltan, no se inventa nada.

### Ghost

Una **clave de Admin API** de una integración personalizada, con la forma `<id>:<secreto hex>`, más la
URL del sitio (la Admin API vive bajo `/ghost/api/admin/`).

```bash
export GHOST_URL="https://blog.example.com"
export GHOST_ADMIN_KEY="6…:9…"
```

El secreto firma localmente un JWT de vida corta con `node:crypto` y nunca sale de la máquina. Una
actualización de entrada debe llevar el `updated_at` actual de la entrada —Ghost lo usa para detectar
colisiones—, así que el adaptador vuelve a leer la entrada justo antes de escribir y se niega cuando
ya no coincide con el plan.

### HubSpot

Un **token de app privada** con los alcances del CMS.

```bash
export HUBSPOT_TOKEN="…"          # sent as a Bearer token
```

Los ids de página salen del listado de páginas, no de la URL. Las entradas de blog viven en un
endpoint distinto al de las páginas del sitio; un mismo payload no sirve para ambos.

### BigCommerce

Un **token de cuenta de API con alcance de tienda** con los alcances de catálogo y contenido, más el
hash de la tienda de la ruta base de la API.

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_TOKEN="…"      # sent as X-Auth-Token
```

Las escrituras son conscientes del canal. Confirma a qué canal pertenece el escaparate auditado antes
de escribir, o un cambio puede aterrizar en un canal que nadie mira. BigCommerce además limita
`page_title` a 70 caracteres y `meta_description` a 160, y rechaza cualquier cosa más larga, así que
un valor demasiado largo se trunca **en un límite de palabra** y la previsualización dice que se
truncó y cuánto.

### PageSpeed Insights (cualquier plataforma)

`PSI_API_KEY` es la única credencial que no tiene nada que ver con escribir: eleva la cuota de PSI
para los Core Web Vitals de campo. Deliberadamente **no existe ninguna bandera `--key`**: un secreto
en la línea de comandos queda en `ps`, en el historial del shell y en cualquier registro de comandos,
y estos scripts imprimen el comando para reproducir la ejecución.

## Inicios rápidos

Todos los flujos son los mismos tres pasos —auditar, planificar, confirmar— con un `--target`
distinto.

### Tienda Shopify

```bash
# 1. Audit (read-only). The profile detects shopify and fills write_targets.
/claude-seo-ai:audit https://my-store.com --pages 12

# 2. Preview the fix plan. Nothing is written; theme changes are staged by construction.
/claude-seo-ai:fix https://my-store.com --target shopify --dry-run

# 3. Confirm the changes you want. Publishing the staging theme is a separate second confirmation.
/claude-seo-ai:fix https://my-store.com --target shopify
```

Por dentro: `shopify theme pull` → editar → `shopify theme check --fail-level error` (un error ahí
bloquea la aplicación) → `shopify theme push --unpublished`. Las escrituras por Admin GraphQL
(`productUpdate(input: { seo: … })`, `urlRedirectCreate`) no tienen superficie de staging: la
previsualización imprime la consulta, las variables y los valores `before`, y luego pregunta.

### Sitio WordPress

```bash
/claude-seo-ai:audit https://example.com --pages 12
/claude-seo-ai:fix   https://example.com --target wordpress --dry-run
/claude-seo-ai:fix   https://example.com --target wordpress
```

Se prefiere REST cuando están presentes `WP_URL` / `WP_USER` / `WP_APP_PASSWORD`; WP-CLI toma el
relevo cuando solo está `WP_SSH`. El `before` se captura de
`GET /wp/v2/posts/<id>?context=edit` y se muestra junto al valor propuesto. Si el sitio tiene un
entorno de staging, ejecuta ahí todo el flujo y promueve con las herramientas de tu hosting.

### Repositorio Next.js (o de cualquier framework)

```bash
# Audit the built output or the running dev server
/claude-seo-ai:audit http://localhost:3000 --pages 8

# Fix the *source*, verified against the dev server
/claude-seo-ai:fix http://localhost:3000 --project . --dev-url http://localhost:3000 --dry-run
```

La auditoría puede haber corrido contra `localhost:3000` o contra HTML compilado, mientras que la
corrección edita el **código fuente** a través del mapa de rutas (`app/(group)/[slug]/page.tsx` → la
ruta que sirve). `--dev-url` vuelve a consultar el servidor de desarrollo en ejecución para verificar.
El informe dice cuál de los tres verificó: un diff en verde no es un sitio corregido hasta que
despliegas.

Solo las estrategias de inserción `html-head`, `front-matter`, `config-file` y `liquid` pueden
producir cambios AUTO. Todas las estrategias de JSX/TS (`metadata-object` sin un ancla literal, la
creación de `next-head-jsx`, `use-seo-meta`, `svelte-head`, `meta-export-array`,
`gatsby-head-export`) son PROPOSED y quedan para el Edit del escritor: nada aquí reescribe JSX con
expresiones regulares.

### Webflow / Wix / Ghost / HubSpot / BigCommerce

```bash
/claude-seo-ai:audit https://example.com
/claude-seo-ai:fix   https://example.com --target webflow --dry-run   # or wix | ghost | hubspot | bigcommerce
```

Cada nombre de proveedor se expande al adaptador `page-api` con ese proveedor seleccionado. Sin su
clave, el destino se degrada a `instructions` y obtienes la ruta de clics exacta con los valores ya
rellenados.

### Squarespace / Framer / cualquier plataforma desconocida

```bash
/claude-seo-ai:audit https://example.com
/claude-seo-ai:fix   https://example.com --target instructions --lang en
```

`instructions` renderiza la ruta del panel y el valor exacto que hay que pegar, en `--lang en|es`. Ese
es el resultado honesto para una plataforma sin API de escritura de SEO: afirmar lo contrario sería
inventar una capacidad.

## SIN VERIFICAR — lo que esta build no afirma

Cada ficha de conocimiento termina con una §12 que lista lo que no se pudo confirmar contra la
documentación oficial del proveedor. Todo lo marcado ahí **no se escribe**: el adaptador informa
`needs_api` o planifica el cambio como `skipped_unready` con el payload impreso para que lo revise una
persona. La lista actual:

| Plataforma | Sin verificar en esta build |
|---|---|
| **Shopify** | La entrada `seo` de `pageUpdate` / `articleUpdate` y los alcances que necesitan: confírmalo contra el esquema `2026-07` fijado antes de escribir páginas o artículos. La versión de API vive en una sola constante; revísala cada trimestre. |
| **WordPress** | `blog_public` a través del endpoint REST de ajustes (solo WP-CLI hasta confirmarlo); el nombre de la opción `wp_attachment_pages_enabled`; `title-description-metas` de SEOPress en el plan gratuito; escrituras REST de AIOSEO sin Pro; la ruta del sitemap de SEOPress. |
| **Webflow** | Los nombres de campo dentro de `openGraph` y la forma de petición de la API de código personalizado. Los campos OG se envían solo cuando un hallazgo los aporta y la previsualización dice que están sin verificar; el código personalizado, las redirecciones y la indexación de staging no se escriben en absoluto. |
| **Wix** | La ruta del endpoint, el cuerpo de la petición y la semántica de publicación de la API de Item SEO Tags. `capabilities` la sondea; hasta que la sonda responda, cada cambio se planifica como `skipped_unready` con el payload a la vista. |
| **Ghost** | La ruta de versión de la Admin API y el procedimiento de firma del JWT. |
| **HubSpot** | El segmento de ruta para pasar de borrador a publicado y el nombre del campo `headHtml`: el HTML de head no se escribe. |
| **BigCommerce** | Las rutas de los endpoints de catálogo/contenido y el payload de asignación de canal. También la cookie `SHOP_SESSION_TOKEN` y el marcador de `stencil-utils`, que son observados en lugar de documentados (la detección nunca descansa en ninguno de los dos por sí solo). |
| **Payload** | Los nombres de campo de `@payloadcms/plugin-seo` y la forma del payload REST. |
| **Magento** | Todos los endpoints REST y códigos de atributo para campos SEO. No se escribe nada. |
| **Drupal** | Los nombres de campo de JSON:API para Metatag, y qué módulos SEO están instalados (ilegible solo desde el HTML). No se escribe nada. |
| **Squarespace** | No existe una API de escritura de etiquetas SEO que podamos citar. El estado sigue siendo `instructions-only`. |
| **Framer** | No hay documentada ninguna API pública de escritura de SEO. El estado sigue siendo `instructions-only`. |

Dos reglas de honestidad relacionadas que aplican en todas partes: un escaparate protegido por
contraseña devuelve la página de contraseña, así que la auditoría es `needs_api`, no un aprobado; y un
plugin activo pero configurado para no emitir nada se ve idéntico a la ausencia de plugin desde fuera
— el hallazgo es el título que falta, no el id del plugin.

## Ver también

- [`docs/es/usage.md`](usage.md) — los cinco comandos y sus banderas reales.
- [`docs/es/architecture.md`](architecture.md) — cómo encajan el perfil, los adaptadores y los
  guardias.
- [`references/platforms/README.md`](../../references/platforms/README.md) — la plantilla de ficha de
  12 secciones, por si quieres añadir una plataforma.
