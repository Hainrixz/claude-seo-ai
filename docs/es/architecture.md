# Arquitectura

`claude-seo-ai` es un plugin de Claude Code que audita y (de forma opcional) corrige el **SEO de
búsqueda** clásico y la **visibilidad en búsqueda con IA (GEO/AEO)** de cualquier sitio web o base de
código web. Este documento describe el diseño **actual**.

La frase que explica todas las demás decisiones: **los scripts adquieren y prueban; el modelo juzga.**
Nada que un script determinista pueda medir se deja a un modelo de lenguaje, y nada que un modelo de
lenguaje suponga puede parecer una medición.

## Puntos de entrada: cinco skills de comando

No hay una skill raíz ni un enrutador de subcomandos. El plugin expone cinco skills de comando
directamente bajo `skills/`, cada una invocada como un comando de barra con espacio de nombres (el
nombre del plugin `claude-seo-ai` es el espacio de nombres):

| Comando | Skill | Propósito | ¿Escribe? |
|---|---|---|---|
| `/claude-seo-ai:audit` | `audit` | Auditoría completa de solo lectura de SEO + búsqueda con IA → dos puntuaciones + un informe persistido | No |
| `/claude-seo-ai:geo` | `geo` | Subconjunto de búsqueda con IA (GEO/AEO) → Visibilidad en IA + desglose de citabilidad, más sondas sin puntuar | No |
| `/claude-seo-ai:score` | `score` | Recalcula/vuelve a mostrar las dos puntuaciones desde una ejecución persistida, sin volver a rastrear | No |
| `/claude-seo-ai:compare` | `compare` | Línea base · staging vs. producción · matriz de competidores · brecha de contenido | No |
| `/claude-seo-ai:fix` | `fix` | Aplica correcciones seguras y deterministas tras una confirmación explícita por cambio | Sí (con restricciones) |

`fix` lleva **`disable-model-invocation: true`**: el modelo nunca puede activarla automáticamente.
Solo se ejecuta cuando el usuario escribe `/claude-seo-ai:fix`. Las otras cuatro son de solo lectura y
el modelo puede invocarlas.

## Tres capas

```
Layer 1  DIRECTIVE     audit · geo · score · compare · fix         (the five command skills)
                                    |
                                    v
Layer 2  ORCHESTRATION  seo-orchestrator
             audit.mjs (acquire → profile → checks → first report)
             -> dispatch four read-only subagents in parallel (one message, four Agent calls)
             -> report.mjs (merge, score, render)
                                    |
                                    v
Layer 3  EXECUTION     23 seo-* module skills (M1..M22), preloaded into their agent
             + the zero-dependency Node scripts that are the acquisition and proof layer
```

**Capa 1 — Directiva.** Las skills de comando son ligeras: analizan `$ARGUMENTS`, entregan el objetivo
y las banderas al orquestador (o, en el caso de `score` / `compare`, directamente al script) y
renderizan los resultados en el idioma del usuario (EN/ES).

**Capa 2 — Orquestación.** `seo-orchestrator` ejecuta **detectar → despachar → sintetizar**. Nunca
pega HTML en la conversación: lee los resúmenes compactos de stdout y los archivos JSON que estos
nombran.

**Capa 3 — Ejecución.** Cada skill de módulo `seo-*` evalúa una sola preocupación y emite hallazgos.
Las skills de módulo tienen `user-invocable: false` y se **precargan en su agente** a través de la
lista `skills:` del agente, así que solo consumen contexto dentro del subagente que las necesita.

## La herramienta de subagentes es `Agent`

El orquestador despacha con la herramienta **`Agent`** —no con el nombre heredado `Task`— en un solo
mensaje que lleva cuatro llamadas, de modo que los especialistas se ejecutan en paralelo y su salida
intermedia verbosa queda aislada en sus propios contextos.

Los agentes nunca dependen de la sustitución `${…}`: el sobre de despacho lleva rutas **absolutas**.

```
ENVELOPE
plugin_root: <absolute ${CLAUDE_PLUGIN_ROOT}>
run_dir: <absolute run dir>
pages: [{slug, url, role}, …]        # <run_dir>/pages/<slug>.json (+ .html, + .rendered.html)
site: robots=…/site/robots.json  sitemaps=…/site/sitemaps.json  discovery=…/site/discovery.json
vertical: {primary, also: […], multilingual}
platform: <run_dir>/profile.json
platform_cards: [<plugin_root>/references/platforms/<id>.md, …]
modules: [<M-ids for this agent>]
deterministic_findings: <run_dir>/findings.deterministic.json   # do not re-emit these ids
return: JSON array only — findings per schema/finding.schema.json, no prose
```

`deterministic_findings` es lo que impide que el modelo vuelva a derivar lo que un script ya probó. Un
agente añade hallazgos juzgados por el modelo encima; nunca reformula el conjunto determinista.

Cada comando de script que ejecuta un agente es absoluto:
`node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"`, que es exactamente la
cadena que cada hallazgo lleva en `verification.reproduce`.

## Adquisición: PageSnapshot v2 en disco

`scripts/snapshot.mjs` obtiene una URL (o lee un archivo local) y escribe un **PageSnapshot** en
`<run>/pages/<slug>.json`, con los bytes al lado como `<slug>.html`. `WebFetch` no es una capa de
adquisición —dentro de Claude Code devuelve un resumen en markdown hecho por un modelo pequeño, nunca
HTML en bruto, cabeceras ni códigos de estado—, así que cada comprobación que dependa de cabeceras,
estados, renderizado o robots lee la salida del script.

```
PageSnapshot {
  snapshot_version, plugin_version, generated_at, run_id
  target        { kind, value, requested_url, final_url, host, origin, slug, path }
  request       { ua_preset, user_agent, accept_language, timeout_ms, max_hops, max_bytes }
  status_chain  [ { url, status, location? } ]        // every hop, in order
  status, ok
  redirects     { hops, loop, truncated, http_to_https, host_changed, www_normalized, … }
  headers       { … }                                  // incl. X-Robots-Tag and content-type
  cookie_names  [ … ]                                  // names only — never values
  header_links  { all[], canonical, alternates[] }     // parsed Link: header
  robots_directives { header, meta[], effective, sources[] }
  body          { bytes, truncated, charset, content_encoding, gunzipped, sha256 }
  timing        { ttfb_ms, download_ms, total_ms }
  raw_html_path, rendered_html_path
  render        { needed, signals[], markers[], mode, renderer, used, confidence, hint, delta }
  parsed        { title, metas[], robots_meta[], lang, canonicals[], hreflang[], anchors[],
                  headings[], images[], scripts[], jsonld[], forms[], iframes[], landmarks,
                  markers, word_count, text_sample, … }
  parsed_rendered                                      // the same shape over the rendered DOM
  site          { robots, sitemaps, sitemap_urls, discovery, robots_txt }   // paths, shared per run
  warnings[], tier
}
```

Detalles que importan aguas abajo:

- **`status_chain` es la cadena completa**, así que un 301→302→200 es un hecho, no una inferencia. Los
  bucles y los truncamientos se señalan en lugar de seguirse indefinidamente.
- **Solo nombres de cookies, nunca valores.** Nada secreto entra en un directorio de ejecución.
- **`--ua <preset>`** escribe un `pages/<slug>.ua-<preset>.json` paralelo, que es como `ua-diff.mjs`
  compara lo que ve un bot con lo que ve un navegador.
- El truncamiento por **`--max-bytes`** se registra en `body.truncated` y se eleva como aviso, así que
  un parseo parcial nunca se hace pasar por uno completo.
- **Los artefactos de sitio se obtienen una vez por ejecución** en `<run>/site/`, no una vez por
  página.

### La decisión de renderizado

`--render` tiene por defecto **`static`**: una ejecución headless nunca abre un navegador salvo que se
lo pidas.

- `needsRender()` observa en el HTML estático: menos de 150 palabras en las regiones de contenido, un
  punto de montaje de framework vacío (`next_root_empty`, `app_root_empty`), marcadores de hidratación
  con menos de 400 palabras, ausencia de `<h1>` y menos de 3 enlaces, o un aviso de tipo «activa
  JavaScript».
- `--render auto` renderiza cuando esas señales se disparan; `--render js` lo intenta siempre.
- El renderizador se encuentra, nunca se instala: `findChrome()` busca un Chrome/Chromium/Edge/Brave
  ya instalado (respetando `CLAUDE_SEO_AI_CHROME`, `CHROME_PATH`, `PUPPETEER_EXECUTABLE_PATH` y luego
  una caché de navegadores de Playwright), y `renderWithPlaywright()` solo se ejecuta cuando el
  paquete `playwright` ya resuelve.
- **`--rendered-file <dom.html>`** toma un DOM capturado en otro lado —un MCP de renderizado, tu
  propio script headless— y lo trata como la pasada renderizada.
- Cuando no hay renderizador disponible, el snapshot mantiene `rendered_html_path: null`, fija
  `render.confidence = reduced`, registra la pista y las comprobaciones emiten un hallazgo M4 honesto.
  Nunca finge haber visto contenido renderizado.

`scripts/crawl.mjs` construye sobre esto: descubrimiento consciente de robots (sitemaps → patrones de
plantilla de URL → recorrido en anchura por los enlaces internos hasta `--depth`) y luego **muestreo
por plantilla**: siempre la portada y el objetivo, después como máximo `--per-template` páginas por
plantilla y por último un relleno round-robin hasta `--pages`. Cada omisión se registra con su motivo
en la tabla de muestreo, así que «miramos 12 de 4.000 páginas» queda visible en lugar de sobrentendido.

## Persistencia

Todo vive en disco, indexado por host e id de ejecución, bajo
`--out` › `$CLAUDE_SEO_AI_HOME` › `$CLAUDE_PLUGIN_DATA/runs` › `~/.claude-seo-ai/runs`. Nunca se
escribe nada dentro del proyecto del usuario. `latest.json` es el puntero portátil (también se escribe
un symlink, en la medida de lo posible, y se tolera un `EPERM` de Windows); `baseline.json` marca la
línea base de comparación y queda exento de la purga. Estructura completa en
[`usage.md`](usage.md#dónde-viven-los-informes).

Esto es lo que hace honestos a `score`, `compare` y `fix`: ninguno trabaja con «la última auditoría de
esta sesión». Los tres leen un `report.json` persistido.

## El perfil del sitio

`scripts/detect-platform.mjs` escribe `<run>/profile.json` antes de que se ejecute cualquier
comprobación. Se puntúan cuatro capas **independientes** —`platform`, `framework`, `plugins`,
`hosting`— para que un WordPress headless detrás de Next.js resuelva como ambos en lugar de que uno
oculte al otro. Una capa con evidencia insuficiente se omite en lugar de adivinarse.

```
profile {
  platform   { id, confidence, signals[] } | null
  framework  { id, confidence, signals[] } | null
  plugins    [ { id, confidence, signals[] } ]
  hosting    { id, … } | null
  environment: production | preview | staging | local
  capabilities  { theme_files, admin_api, rest_api, page_api, robots_editable, redirects, head_owner }
  write_targets [ { adapter, ready, needs: [<KEY names>] } ]
  vertical      { primary, also[], multilingual, source: declared|inferred, signals }
  vertical_hints[], cards[]
}
```

`cards[]` nombra las fichas de conocimiento (`references/platforms/<id>.md`) que el orquestador pasa a
cada subagente como `platform_cards`. Una ficha es el único lugar donde un subagente puede aprender
qué genera una plataforma por sí sola, qué se niega a dejar cambiar y cómo se escribiría realmente una
corrección — que es lo que evita que un auditor «corrija» algo que la plataforma controla.
`write_targets[].needs` lista **nombres** de claves de credenciales, nunca valores.

## El registro de comprobaciones

`scripts/checks/*.mjs` es la mitad determinista de la auditoría: 25 comprobaciones que emiten 151 ids
de hallazgo repartidos entre M1 y M22. Cada módulo exporta el mismo contrato mínimo:

```js
export const module = 'M7';                 // the Mn owner
export const ids = ['M7.title.missing', …]; // every id this check can emit
export const scope = 'page';                // page | template | site
export function run(ctx) { … }              // -> findings[]
```

`ctx` lleva `{ page, parsed, rendered, site, crawl, pages, options, root }`. `index.mjs` descubre las
comprobaciones recorriendo el directorio —no hay ninguna lista de registro que editar— y exporta
`CHECKS` (congelado), `knownIds()`, `loadRunContext()` y `runChecks(ctx)`.

`runChecks` **nunca lanza excepciones**. Una comprobación que falla se aísla por página, su error se
registra y la ejecución continúa; las `stats` devueltas llevan recuentos por módulo más `needs_api`,
`manual_review`, `not_applicable`, `dropped` (con `dropped_findings[]`) y `errors`. Ese bloque se
persiste como `<run>/checks.json`, así que «qué comprobaciones se ejecutaron y cuáles reventaron» es
auditable en lugar de folclore.

Los hallazgos se construyen únicamente a través de `makeFinding()` de `scripts/lib/finding.mjs`, que
rellena el comando `reproduce` absoluto y valida la forma contra `schema/finding.schema.json` antes de
que pueda salir de una comprobación.

## El runner

```
audit.mjs  <url|path|run-dir>
   ├─ acquire      crawl.mjs (a URL) · snapshot.mjs (--pages 1, --no-crawl, or a local path)
   │               · nothing at all when handed an existing run directory
   ├─ profile      detect-platform.mjs -> profile.json
   ├─ checks       runChecks() -> findings.deterministic.json + checks.json
   └─ report       report.mjs -> findings.json, report.json, report.md
```

`report.mjs` es el punto de fusión. Valida cada hallazgo contra el esquema (los inválidos se
**descartan a `report.dropped_findings`**, nunca se ignoran en silencio), elimina duplicados por id
más ubicación normalizada conservando el estado más severo, puntúa por página y como agregado de
sitio, y renderiza el informe bilingüe en markdown con las 15 acciones principales ordenadas por
severidad × magnitud ÷ esfuerzo.

Una regla de fusión sostiene toda la postura de honestidad: **`needs_api` y `manual_review` nunca
anulan un estado puntuado.** Un agente que no pudo decidir no debe borrar una comprobación que sí lo
hizo. La precedencia es
`fail (5) > warn (4) > pass (3) > needs_api (2) > manual_review (1) > not_applicable (0)`.

Los códigos de salida son uniformes en todos los scripts: `0` ok · `1` invocación incorrecta · `2`
error en tiempo de ejecución · `3` se activó un umbral o una compuerta. `--fail-under
search=70,ai=60`, `--fail-on-gated` y `--fail-on-severity N` son las compuertas de CI; una compuerta
activada es un código 3, que es un asunto de CI, no una auditoría fallida.

## Subagentes

Cinco subagentes en `agents/`. Cuatro son estrictamente de **solo lectura** —sin `Write`/`Edit` en su
lista de herramientas permitidas—, de modo que una auditoría nunca puede modificar archivos. Solo
`seo-fixer-writer` puede escribir, y únicamente a través de `fix`, tras confirmación y con un ticket.

| Subagente | Herramientas | `skills:` precargadas | Módulos |
|---|---|---|---|
| `technical-auditor` | Read, Grep, Glob, Bash, WebFetch | seo-crawlability, seo-indexability, seo-rendering, seo-core-web-vitals, seo-mobile, seo-meta-onpage, seo-headings-structure, seo-social-cards, seo-images-media, seo-internal-linking, seo-sitemaps, seo-international | M1, M2 (+M3), M4, M7/M7b/M7c, M8, M9, M10, M15, M17 — más M20 cuando `vertical.multilingual` |
| `ai-search-geo-specialist` | Read, Grep, Glob, WebFetch, Bash | seo-geo-answerblocks, seo-geo-factdensity, seo-ai-crawlers, seo-entity-linking, seo-ai-discovery, seo-agent-readiness | M6, M11, M12, M14, M21 (peso 0), M22 |
| `content-eeat-analyst` | Read, Grep, Glob, WebFetch, Bash | seo-eeat, seo-freshness | M13, M16 |
| `schema-generator` | Read, Grep, Glob, Bash, WebFetch | seo-schema-jsonld, seo-entity-linking, seo-ecommerce, seo-local | M5 — más M18 cuando `ecommerce`, M19 cuando `local-business` |
| `seo-fixer-writer` | Read, Grep, Glob, **Edit, Write**, Bash | seo-fix-apply | El único escritor; lo usa `fix` tras la confirmación (`maxTurns: 80`) |

Los cinco corren con `model: inherit`. `schema-generator` propone diffs de JSON-LD pero no los
escribe; la escritura siempre pasa por `seo-fixer-writer`.

## Enrutamiento por vertical

`seo-vertical-detect` clasifica el objetivo como `ecommerce`, `local-business`, `blog-publisher`,
`saas`, `docs` o `generic` (un sitio puede coincidir con varios), tomando `profile.vertical_hints`
como señales de entrada. Los módulos siempre activos se ejecutan en todos lados; la vertical desbloquea
los condicionales —M18 (e-commerce), M19 (local), M20 (internacional, cuando hay `multilingual`)— y el
scorer renormaliza los pesos para que una categoría inactiva nunca penalice al sitio. Tabla completa
en [`references/routing.md`](../../references/routing.md).

El detector solo **adivina**: `profile.vertical.source` sigue siendo `"inferred"` salvo que se pase
`--vertical`. Declararla es lo que hace que las comprobaciones condicionales se disparen de forma
determinista.

## Dos puntuaciones, nunca mezcladas

`scripts/score.mjs` produce **dos puntuaciones independientes de 0 a 100** que nunca se promedian:
**SEO de búsqueda** y **Visibilidad en IA (GEO/AEO)**. Una página puede posicionar bien y aun así ser
imposible de citar por la IA, o al revés — mostrar ambas es la tesis del producto.

- **Valor de categoría** = `100 × Σ(status_factor × severity) / Σ(severity)` sobre los hallazgos
  puntuados, donde `status_factor` es pass `1.0`, warn `0.5`, fail `0.0`. `needs_api`,
  `manual_review` y `not_applicable` se excluyen de ambas sumas.
- **Puntuación** = `Σ(category_value × weight) / Σ(active weight)`; las categorías condicionales entran
  en el denominador solo cuando están activas, y luego los pesos se renormalizan.
- Un hallazgo contribuye únicamente al eje nombrado en su `expected_impact.axis` (`search`, `ai` o
  `both`).
- **Bandas:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F por debajo.
- **Limitación por severidad:** un hallazgo con `severity: 5`, **`established`** y fallido dentro de
  una categoría activa con peso topa ese eje en **40** y fija `capped: true`, listando sus
  `cap_reasons`. La confianza forma parte de la compuerta a propósito: un fallo `directional` de
  severidad 5 nunca topa.
- **Piso de cobertura:** cuando menos del **50 %** del peso siempre activo de un eje llevó un hallazgo
  puntuado, el eje queda en `state: "partial"`, `provisional: true`, y el informe nombra las
  categorías no medidas. Una ejecución de una sola página que midió dos categorías no puede aparentar
  una A.
- **`unscored`:** ningún hallazgo puntuado en ninguna categoría activa → `state: "unscored"`, no F.
  Una puntuación ausente no es una mala puntuación.

El modelo completo, incluidos los pesos y la tabla de calibración, está en [`scoring.md`](scoring.md)
y [`references/scoring-model.md`](../../references/scoring-model.md).

## Contrato de hallazgos

Cada hallazgo cumple con `schema/finding.schema.json`. El esquema prioriza la falsabilidad: cada
hallazgo debe ser observable y re-verificable de forma independiente. Los campos obligatorios incluyen
`id` (con prefijo del módulo, p. ej. `M5.article.missing_datemodified`), `module`, `title`, `status`
(`pass`/`warn`/`fail`/`not_applicable`/`needs_api`/`manual_review`), `severity` (0–5), `scope`,
`evidence.observed` (textual), `expected`, `recommendation`, `fixable`, `verification` (`method` +
`assertion` + un `reproduce` absoluto y ejecutable) y `expected_impact` (`axis` + `confidence` +
`magnitude` + `rationale`).

`fixable` dirige al corrector:

- **auto** — determinista, aditivo, verificable por máquina, con bajo riesgo semántico.
- **proposed** — modifica el texto o el significado; requiere aceptación por elemento.
- **advisory** — esta herramienta nunca lo escribe.

## El flujo de corrección

```
report.json + profile.json
   -> fix-plan.mjs           groups findings by the adapter that owns each surface
   -> plan.json + manifest.json + coverage accounting
   -> <adapter> preview      (read-only, per change)
   -> the user confirms
   -> fix-ticket.mjs issue   one-shot, 15-minute ticket bound to the exact command
   -> seo-fixer-writer       Edit/Write for local diffs · ticketed adapter apply for remote
   -> <adapter> verify       or pending_cache — never a pass on a stale cache
   -> <adapter> rollback     from before/*.json and <DATA>/backups/<run-id>/
```

### Adaptadores

Todos los adaptadores de `scripts/adapters/` implementan las mismas seis operaciones —
`capabilities | plan | preview | apply | verify | rollback` — como un CLI
(`node scripts/adapters/<id>.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>]`), con
`fetchImpl` / `execImpl` inyectables para que las pruebas nunca toquen la red.

| Adaptador | Superficie |
|---|---|
| `local-files` | un árbol de código en disco (cualquier framework, o HTML plano), a través del mapa de rutas |
| `shopify-theme` | Shopify CLI: pull → editar → `theme check` → push a un tema **sin publicar** |
| `shopify-admin` | Admin GraphQL para campos SEO por recurso y redirecciones |
| `wordpress-rest` | Application Passwords sobre HTTPS con autenticación Basic |
| `wordpress-wpcli` | `wp` por SSH, cuando REST no está disponible |
| `page-api` | multiplexa los proveedores de solo lectura: `webflow`, `wix`, `ghost`, `hubspot`, `bigcommerce` |
| `instructions` | la ruta de clics exacta, en EN o ES, con los valores ya rellenados — la alternativa honesta |

`instructions` siempre se añade al final, así que **cada hallazgo tiene adónde ir**. Una credencial
ausente degrada un destino a `instructions`; nunca hace fallar la ejecución y nunca se elimina del
resumen.

Tres invariantes comunes a todos:

1. **Nunca escribir en vivo por defecto.** Shopify sube a un tema sin publicar; Webflow y HubSpot
   quedan en staging; Ghost nunca cambia `status`; WordPress nunca toca `status` ni el contenido de
   las entradas. Donde una plataforma no tiene superficie de staging (Wix, BigCommerce), el cambio se
   etiqueta `[LIVE]` antes de preguntarle al usuario. Detalle por plataforma:
   [`platforms.md`](platforms.md).
2. **`updateManifest()` es la única vía de reporte** para cada apply, publish y rollback. Mantiene
   `dry_run` (falso solo cuando una escritura realmente ocurrió), las listas de ids `applied` /
   `rolled_back` / `failed`, un mapa `results` por cambio, `last_op` y una marca de tiempo `<op>_at`,
   así que un manifiesto se puede reproducir con honestidad.
3. **Un cambio nunca retrocede** en su máquina de estados
   (`planned → previewed → confirmed → applied → verified | pending_cache | failed | rolled_back`, más
   `skipped_idempotent` y `skipped_unready`). Una excepción marca el cambio como `failed` y persiste
   el mensaje en lugar de dejar un estado a medias.

### Contabilidad de cobertura

Sin ella, un adaptador que descartara en silencio todos los hallazgos `proposed` podría imprimir
«2 cambios» sobre un informe de 30 hallazgos. Por eso `fix-plan.mjs` clasifica **todos** los
hallazgos: `actionable`, `considered`, `planned` (auto + proposed), `skipped_proposed` (con los ids y
la pista de `--include-proposed`), `advisory` y `unroutable` (considerados pero sin adaptador dueño),
más un desglose por adaptador. `planned ⊆ considered`, `unroutable = considered − planned`. El mismo
objeto aparece en el resultado del CLI, en `plan.coverage`, en cada grupo, en el resumen impreso y en
`manifest.counts`.

## El modelo de guardias

Cuatro mecanismos, en orden de cuánto garantizan realmente:

1. **Listas de herramientas permitidas.** Los cuatro agentes auditores no tienen `Write`/`Edit`. Es la
   garantía más fuerte de todas: una auditoría no puede modificar archivos porque las herramientas no
   están en la lista del agente.
2. **`disable-model-invocation: true` en `fix`.** El modelo no puede iniciar un flujo de escritura en
   absoluto.
3. **`guard-write.mjs`** — un hook `PreToolUse` sobre `Write|Edit|MultiEdit|NotebookEdit`. Lee todos
   los campos de ruta que usan las herramientas de archivo, así que añadir una herramienta al matcher
   nunca requiere cambiar nada aquí. Dos decisiones deliberadamente distintas:
   - una **ruta protegida** (`.git/`, `.env*`, `.envrc`, directorios de SSH/GnuPG/AWS, claves
     privadas, `.pem`/`.key`/`.p12`…, lockfiles, `wp-config.php`, un `settings_data.json` de un tema
     de Shopify publicado) → **deny**. Ninguna corrección de SEO necesita jamás una de estas.
   - una ruta **fuera de las raíces de contención** (el proyecto, sus `.claude/worktrees`, el
     directorio de datos del plugin) → **ask**, para que llegue a la decisión de permisos del propio
     usuario en lugar de aceptarse en silencio bajo `acceptEdits`. No es un deny porque el hook está
     instalado para toda la sesión, no solo para `fix`: rechazar toda escritura fuera del proyecto
     rompería trabajos ajenos.
4. **`guard-bash.mjs`** — el mismo evento de hook sobre `Bash`, que cierra lo que `guard-write` no
   puede ver: el escritor dispone de `Bash`, y un comando de shell puede publicar un tema, reescribir
   una opción de WordPress, hacer POST a una Admin API o machacar un `.env` con una redirección. Tres
   niveles:
   - **rechazo duro** — `shopify theme push` con una bandera de publicación en vivo (`--allow-live`,
     `--live`, `--publish`, `-a`, `-l`, `-p`), y las redirecciones de shell o `tee` hacia un archivo
     protegido. Ningún ticket desbloquea esto.
   - **con ticket** — la superficie de escritura remota (push/publish/delete de temas de Shopify;
     escrituras de opciones y post-meta con WP-CLI, en local o por SSH; escrituras con
     `curl`/`wget`/`node -e` contra las APIs de las plataformas; y los propios `apply`/`publish`/
     `rollback` de los adaptadores). Con un ticket vigente para ese comando exacto, **pregunta**; sin
     él, **rechaza**.
   - **todo lo demás** — código 0, sin opinión. Una comprobación previa por expresión regular mantiene
     esa vía en microsegundos; no se lee nada del disco salvo que coincida un patrón restringido.

Ninguno de los dos hooks emite jamás `allow`. Código 0 sin salida significa «sin opinión», lo que cae
en la confirmación del propio usuario: nunca la elimina.

**El límite honesto.** Los hooks heredan el entorno de Claude Code, así que un ticket de confirmación
es *refuerzo procedimental, no un límite de capacidad*: todo lo que el modelo puede leer, también lo
puede escribir. El verdadero respaldo es la confirmación de permisos de Bash del propio usuario. Nunca
pongas en la lista de permitidos `Bash(shopify:*)`, `Bash(wp:*)` ni `Bash(ssh:*)`: eso es exactamente
lo que estos hooks no pueden sustituir.

## Salvaguardas de honestidad

- **M21 (descubrimiento para IA: `llms.txt`, `agents.md`, `/.well-known/ucp`, `ai-catalog.json`, el
  sitemap agéntico) tiene peso 0 en ambos ejes.** Se informa, nunca se puntúa. Google Search ignora
  `llms.txt`; ningún motor documenta que consuma los demás para recuperación.
- **Solo lo que un motor de búsqueda documenta puede ser `established`.** En el eje de IA eso es la
  elegibilidad de M14 y nada más. Todo lo demás es `directional` o `speculative`, y solo los fallos
  `established` pueden topar una puntuación.
- **Las sondas nunca se puntúan.** `--probe` (presencia en búsqueda web) y `--gsc-ai-export` (una
  exportación manual de IA generativa de Search Console) tienen severidad 0, quedan excluidas de la
  puntuación y de todos los topes, y llevan su advertencia textual desde el script en lugar de en
  palabras del modelo.
- **`needs_api` / `manual_review` nunca son una aprobación silenciosa**, nunca anulan un estado
  puntuado y se informan como confianza de la puntuación.
- **Las comprobaciones dependientes del idioma están restringidas por idioma.** Las heurísticas
  incluyen léxicos EN y ES; en una página en cualquier otro idioma esa parte se omite y se indica el
  motivo (`language_dependent_checks: manual_review`) en lugar de puntuarla como limpia. Una
  heurística solo en inglés nunca debe puntuar con cero una página en español.
- Los Core Web Vitals de **laboratorio frente a campo** se distinguen con claridad; solo el p75 de
  campo de CrUX mueve la puntuación.
- **Sin fabricación**: nunca inventar estadísticas, citas, fechas (sin antedatar `dateModified`),
  credenciales ni enlaces de identidad `sameAs`. Los valores desconocidos se preguntan o se dejan como
  un marcador `TODO:<field>` claramente señalado.
- **Una página que no respondió 2xx nunca se puntúa.** Las verificaciones on-page se saltan una
  página que no es contenido, así que un 404 o un intersticial 429 apenas acumularía hallazgos
  negativos y puntuaría por encima de una página real. Esa página se queda en `pages[]` de
  `report.json` con su `status` y `scorable: false`, se lista en `site_rollup.unscored_pages`, se
  nombra en un aviso y no aporta peso al agregado; `compare` informa el cambio 200 → 429 como cambio
  de cobertura, nunca como una mejora.
- **Un 200 que sirve HTML en un endpoint para máquinas es un soft 404.** `/llms.txt`,
  `/llms-full.txt`, `/agents.md`, `/.well-known/ucp`, `/.well-known/ai-catalog.json` y el sitemap
  agéntico no son documentos HTML: una página comodín ahí significa que el archivo no está publicado.
  Esas rutas pasan de `discovery.summary.found` a `discovery.summary.soft_404` (su estado se sigue
  registrando), de modo que ni el informe ni la matriz de presencia de competidores afirman que un
  sitio publica un archivo que no publica.
- **Sin porcentajes desnudos.** El impacto se expresa por bandas, y las cifras publicadas aparecen
  solo dentro de `rationale`.

## Modo degradado

Si falta `node`, o si una instalación solo-skills no trae directorio `scripts/`, el orquestador lo
dice **primero**, recurre a resúmenes de `WebFetch`, marca como `needs_api` cada hallazgo que dependa
de cabeceras, estados, renderizado o robots, omite la persistencia y etiqueta el informe como **«modo
solo-prompt: no comparable con una ejecución con scripts»**. Nunca presenta un resumen de `WebFetch`
como HTML en bruto ni como un estado medido.
