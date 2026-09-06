# Uso

Una guía práctica para ejecutar `claude-seo-ai`: instalarlo, ejecutar los cinco comandos, encontrar
los informes que persiste y aplicar correcciones de forma segura en la plataforma donde viva tu sitio.

## Instalación

**Como plugin de Claude Code (recomendado):**

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

**Multiagente (Cursor, Codex, Gemini CLI, Windsurf…) mediante Vercel Skills:**

```
npx skills add Hainrixz/claude-seo-ai
```

> Publicado en `github.com/Hainrixz/claude-seo-ai`. El plugin funciona totalmente sin conexión
> (Tier 0): no requiere claves. `npx skills add` instala **solo las skills en Markdown**; la capa de
> adquisición `scripts/`, los subagentes y los hooks forman parte del canal de plugin. Consulta
> [`distribution.md`](distribution.md).

## Los cinco comandos

`claude-seo-ai` incluye **cinco skills de comando**: `audit`, `geo`, `score`, `compare` y `fix`. No
hay enrutador raíz ni análisis de subcomandos: cada uno es su propio comando de nivel superior. Claude
Code asigna un espacio de nombres a las skills de un plugin, así que cada comando se invoca como
`/claude-seo-ai:<comando>`. El objetivo es una URL (`https://…`) o una ruta local (un proyecto web o
HTML compilado).

```
/claude-seo-ai:audit   <url|path> [--pages N] [--max N] [--render static|auto|js]
                                  [--ua default|googlebot|bingbot|gptbot|oai-searchbot|claude-searchbot]
                                  [--vertical ecommerce,docs] [--environment production|preview|staging|local]
                                  [--feed <path>] [--out <dir>]

/claude-seo-ai:geo     <url|path> [--pages N] [--render static|auto|js] [--feed <path>]
                                  [--probe "<question>"] [--gsc-ai-export <csv>]

/claude-seo-ai:score   [findings.json | run-dir | latest[:host]]

/claude-seo-ai:compare <urlA> <urlB> [<urlC>…]
                     | --baseline [latest] --against <url|run>
                     | --staging <url> --prod <url>
                     | <url> --gap "<query>"

/claude-seo-ai:fix     <url|path> [--target auto|local|shopify|wordpress|page-api|webflow|wix|ghost|hubspot|bigcommerce|instructions]
                                  [--category M5 --category auto] [--include-proposed]
                                  [--project <dir>] [--dev-url <u>] [--run <run_id|latest>] [--report <path>]
                                  [--lang en|es] [--dry-run] [--publish] [--rollback <run_id>] [--force]
```

| Comando | Qué hace | ¿Escribe archivos? |
|---|---|---|
| `audit` | Auditoría completa de solo lectura en ambos ejes; persiste una ejecución y un informe. | No, nunca |
| `geo` | Subconjunto de búsqueda con IA (GEO/AEO) → puntuación de Visibilidad en IA + informe de citabilidad, más sondas sin puntuar. | No |
| `score` | Recalcula/muestra las dos puntuaciones a partir de una ejecución persistida o un archivo de hallazgos. | No |
| `compare` | Línea base, staging vs. producción, matriz de competidores o brecha de contenido, siempre desde ejecuciones persistidas. | No |
| `fix` | Corrector opcional (opt-in); previsualiza todo y escribe solo después de que confirmes cada cambio. | Solo al confirmar |

`audit`, `geo`, `score` y `compare` son de solo lectura y pueden activarse por descripción. `fix`
lleva `disable-model-invocation: true`: solo **tú** puedes invocarlo, y el modelo nunca lo activa
automáticamente.

Todos los artefactos viven bajo el directorio de datos del plugin, nunca dentro de tu proyecto.

### `audit`

De solo lectura. Invoca a `seo-orchestrator`, que ejecuta toda la canalización determinista en un
solo comando (`scripts/audit.mjs`), detecta plataforma y vertical, despacha en paralelo los cuatro
subagentes especialistas de solo lectura, fusiona sus hallazgos en la ejecución persistida y puntúa.

```
# A live site, sampling 12 pages (the default)
/claude-seo-ai:audit https://example.com

# One page only
/claude-seo-ai:audit https://example.com --pages 1

# A client-rendered SPA — render is opt-in, never automatic
/claude-seo-ai:audit https://example.com --render auto

# A local project or built output
/claude-seo-ai:audit ./dist

# Declare the vertical instead of letting the run infer it
/claude-seo-ai:audit https://shop.example.com --vertical ecommerce --feed ./products.jsonl

# A preview deployment: the expected noindex/robots caps are suppressed
/claude-seo-ai:audit https://pr-42.vercel.app --environment preview
```

Las banderas, tal como las lee `audit.mjs`:

| Bandera | Valor por defecto | Significado |
|---|---|---|
| `--pages N` | 12 | Cuántas páginas muestrear. Con `--pages 1` toma un snapshot en lugar de rastrear. |
| `--max N` | 40 | Cota superior de la frontera de URLs que el rastreador considerará. |
| `--render static\|auto\|js` | `static` | **Una auditoría headless nunca abre un navegador salvo que se lo pidas.** `auto` renderiza cuando el HTML estático parece depender de JS; `js` lo intenta siempre. |
| `--ua <preset>` | nuestro propio token | `default`, `googlebot`, `bingbot`, `gptbot`, `oai-searchbot`, `claude-searchbot`, o una cadena de UA literal. |
| `--vertical <ids>` | inferida | Lista separada por comas de `saas,blog-publisher,local-business,ecommerce,docs,generic`. Declararla es lo que activa las categorías condicionales de forma determinista. |
| `--environment <kind>` | `production` | `production`, `preview`, `staging`, `local`. |
| `--feed <path>` | — | Un feed de productos para el lint del Agentic Commerce Protocol (solo en la vertical de e-commerce). |
| `--out <dir>` | el directorio de datos | Raíz de las ejecuciones. |

Obtienes: ambas puntuaciones con sus bandas e interpretaciones de una línea, tablas por categoría, la
tabla de muestreo (plantillas descubiertas frente a muestreadas, y cada omisión con su motivo), el
nivel de datos alcanzado, los recuentos de `needs_api` / `manual_review`, el perfil de plataforma
detectado y las acciones priorizadas por impacto ÷ esfuerzo. Termina ofreciéndote `fix` y `compare`.

### `geo`

Solo el subconjunto de búsqueda con IA: extraibilidad de respuestas (M11), densidad de hechos (M12),
acceso de rastreadores de IA y elegibilidad para las funciones de IA de Google (M14), endpoints de
descubrimiento para IA (M21, peso 0), preparación para agentes (M22), enlazado de entidades (M6), más
schema (M5) y renderizado (M4), porque alimentan la visibilidad en IA.

```
/claude-seo-ai:geo https://example.com
/claude-seo-ai:geo https://example.com --probe "best sustainable running shoes"
/claude-seo-ai:geo https://example.com --gsc-ai-export ./search-console-generative-ai.csv
```

`--pages`, `--render` y `--feed` se reenvían sin cambios a `audit.mjs`. `--probe` y `--gsc-ai-export`
los maneja la skill: son **sondas — se informan, nunca se puntúan** (severidad 0, excluidas de la
puntuación de Visibilidad en IA y de todos los topes). Consulta
[«Sondas»](#sondas-se-informan-nunca-se-puntúan) más abajo.

### `score`

Recalcula las dos puntuaciones a partir de una ejecución persistida, sin volver a rastrear, ejecutando
`scripts/score.mjs` para obtener un número reproducible.

```
# The most recent run for a host
/claude-seo-ai:score latest:example.com

# A specific run directory
/claude-seo-ai:score ~/.claude-seo-ai/runs/example.com/2026-09-06T10-14-33Z

# A saved findings file
/claude-seo-ai:score ./findings.json
```

Directamente:

```bash
node scripts/score.mjs --run <run-dir>                       # reads <run-dir>/findings.json
node scripts/score.mjs --findings findings.json --vertical ecommerce --multilingual
node scripts/score.mjs --findings findings.json --environment staging
cat findings.json | node scripts/score.mjs
```

> `score.mjs --run` acepta un **directorio o un archivo de hallazgos: no entiende la palabra
> `latest`**. La skill resuelve el puntero por ti; si lo automatizas tú, lee
> `<root>/<host>/latest.json` (`{ run, path, updated_at }`) y pasa su `path`.

`--strict` termina con código 2 cuando algún hallazgo se descartó por ser inválido según el esquema,
en lugar de descartarlo en silencio. `--validate-only` comprueba los hallazgos e informa sin puntuar.

### `compare`

Cuatro comparaciones, un solo script, todas a partir de ejecuciones persistidas. Una URL sin ejecución
se audita primero (de forma determinista, `--pages 3 --render static`), nunca se omite en silencio.

```
# Did this deploy make anything worse?
/claude-seo-ai:compare --baseline latest --against https://example.com

# Staging vs production
/claude-seo-ai:compare --staging https://staging.example.com --prod https://example.com

# Up to five sites side by side
/claude-seo-ai:compare https://example.com https://rival-a.com https://rival-b.com

# What do the pages that already answer this query have that we don't?
/claude-seo-ai:compare https://example.com --gap "how to choose running shoes"
```

Directamente:

```bash
node scripts/compare.mjs --baseline latest --against <url|run-dir> [--mode auto|baseline|staging|competitor|gap]
node scripts/compare.mjs --prod <ref> --staging <ref>
node scripts/compare.mjs <refA> <refB> [<refC>…]
node scripts/compare.mjs --subject <ref> --set <ref,…> --query "<q>" --mode gap
```

Un `<ref>` es un directorio de ejecución, un `report.json`, `latest[:<host>]`, `baseline[:<host>]` o
una URL.

| Modo | Cuándo lo elige `--mode auto` | Qué obtienes |
|---|---|---|
| `baseline` | ambas referencias resuelven al mismo host | deltas de puntuación y de categoría, más un diff de hallazgos: corregidos, nuevos, con regresión, mejorados, sin cambios |
| `staging` | dos hosts unidos por `--map`, o uno que parece un despliegue de staging (`staging.`, `preview`, `.vercel.app`, `.myshopify.com`) | el mismo diff, con los hosts normalizados para que un cambio de URL no se lea como un hallazgo nuevo |
| `competitor` | dos o más hosts distintos y sin `--map` | tabla de puntuaciones y categorías, matriz de presencia y brechas «sujeto vs. el mejor del conjunto» — **sin diff de hallazgos entre sitios** |
| `gap` | se fija explícitamente con `--subject` / `--set` / `--query` | temas de encabezado presentes en ≥2 rivales y ausentes en ti, tipos de schema, frecuencias de hechos, recuentos de palabras, bloques de respuesta, endpoints agénticos |

Banderas útiles: `--map staging.example.com=example.com` (repetible) · `--format json|md` ·
`--fail-on-regression` (código 3 ante cualquier hallazgo con regresión o si un eje cae más de 2
puntos) · `--set-baseline` (escribe `runs/<host>/baseline.json`, que queda exento de la purga) ·
`--data` (imprime el documento de comparación completo en lugar del resumen).

Las transiciones que involucran `needs_api` / `manual_review` se listan por separado y **nunca**
cuentan como corregidas ni como regresión: perder una clave de API no es una regresión de tu sitio.

La misma regla cubre la muestra de páginas. Cuando una página que una ejecución puntuó queda sin
puntuar en la otra —volvió con 429 o 404, o ese rastreo nunca la muestreó—, las dos puntuaciones de
sitio son medias sobre conjuntos de páginas distintos. Esas páginas se listan en `page_coverage`, sus
filas por página se marcan con `coverage_change` en lugar de llevar un delta, los deltas de eje dejan
de contar para el veredicto y un aviso explica por qué. Un rastreo con límite de tasa nunca puede
leerse como una mejora.

Notas de honestidad que la skill te repite: `WebSearch` en modo gap es un motor en un momento
concreto, no seguimiento de posiciones; las puntuaciones de competidores describen estructura, no
posiciones previstas; y una ejecución solo determinista se etiqueta como tal.

### `fix`

Escritor opcional (opt-in): se detalla completo más abajo.

## Dónde viven los informes

No se escribe nada dentro de tu proyecto. Las ejecuciones viven bajo una raíz que se resuelve en este
orden:

```
--out <dir>  ›  $CLAUDE_SEO_AI_HOME  ›  $CLAUDE_PLUGIN_DATA/runs  ›  ~/.claude-seo-ai/runs
```

```text
<root>/index.json                       every host, its runs, its latest and baseline ids
<root>/<host>/latest.json               { run, path, updated_at }  ← the portable pointer
<root>/<host>/latest                    a symlink to the same run (best effort; Windows-tolerant)
<root>/<host>/baseline.json             set by `compare --set-baseline`; exempt from pruning
<root>/<host>/<run-id>/
    crawl.json                          pages, roles, templates, the sampling table, warnings
    profile.json                        platform / framework / plugins / hosting / environment
                                        + capabilities + write_targets + vertical
    pages/<slug>.json                   one PageSnapshot per page (+ .html, + .rendered.html)
    site/robots.json  site/robots.txt   the parsed robots.txt and the bytes it came from
    site/sitemaps.json                  sitemap index recursion, gzip handled
    site/discovery.json                 llms.txt, agents.md, /.well-known/ucp, agentic sitemap…
    checks.json                         checks run, per-module counts, errors, dropped findings
    findings.deterministic.json         what the scripts proved
    agents/<agent>.json                 what each subagent judged
    findings.json                       the merged, deduplicated, schema-valid set
    report.json                         conforms to schema/audit-report.schema.json
    report.md                           the human report (EN/ES)
<root>/compare/<a>__<b>/compare.json    comparisons
```

`<host>` es el host en minúsculas con `:` → `_` (así un puerto sobrevive en cualquier sistema de
archivos); los objetivos locales se convierten en `local/<basename>-<hash>`. Los ids de ejecución son
marcas de tiempo UTC, así que ordenan cronológicamente. La retención conserva las últimas 20
ejecuciones por host (5 para hosts de análisis de brechas); la línea base nunca se purga.

`--lang en|es` fija el idioma de `report.md` y de todo lo que se escribe alrededor de los números:
encabezados, etiquetas de tabla, la línea de interpretación y cada aviso. El texto de los hallazgos
—título, evidencia, recomendación— sigue en inglés, porque viene de las verificaciones.

El flujo de corrección usa un segundo árbol bajo el directorio de datos:

```text
<DATA>/fix/runs/<run-id>/plan.json      every planned Change, with its coverage accounting
<DATA>/fix/runs/<run-id>/manifest.json  dry_run, confirmed ids, per-change results, timestamps
<DATA>/fix/runs/<run-id>/preview/…      the rendered diff / payload / command / instructions
<DATA>/fix/runs/<run-id>/before/…       pre-write state, which is what a rollback restores
<DATA>/fix/runs/<run-id>/after/…        post-write state, which is what verify reads
<DATA>/fix/runs/<run-id>/log.ndjson     append-only audit log (commands redacted)
<DATA>/backups/<run-id>/<relpath>       byte-for-byte copies of every edited local file
<DATA>/fix/tickets/<sha256>.json        one-shot confirmation tickets, 15-minute TTL
```

## Lectura del informe de doble puntuación

Dos puntuaciones **independientes** de 0 a 100, nunca combinadas en una sola. Una página puede
posicionar bien en Google y aun así ser imposible de citar por los motores de IA, o al revés.

| Puntuación | Ponderada hacia |
|---|---|
| **Search SEO** | indexabilidad y rastreo, Core Web Vitals, on-page, datos estructurados, renderizado, enlazado interno |
| **AI Visibility (GEO/AEO)** | extraibilidad de respuestas, acceso y elegibilidad de rastreadores de IA, densidad de hechos, schema, renderizado, entidades |

Cada puntuación tiene una banda con letra (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F por debajo) más una
interpretación de una línea. Pesos y fórmulas completos: [`scoring.md`](scoring.md) y
[`references/scoring-model.md`](../../references/scoring-model.md).

Un eje puede estar en cuatro estados, y cada uno significa algo distinto:

- **`scored`** — suficiente peso siempre activo llevó un hallazgo puntuado.
- **`partial`** (*provisional*) — la cobertura queda por debajo del 50 % del peso siempre activo, así
  que la banda se marca como provisional y el informe nombra las categorías no medidas. Una ejecución
  de una sola página que solo midió dos categorías no puede aparentar una A.
- **`capped`** — un hallazgo de **severidad 5, `established` y fallido** dentro de una categoría
  activa topa el eje en 40. Solo la confianza `established` puede topar: un fallo `directional` de
  severidad 5 nunca lo hace.
- **`unscored`** — ningún hallazgo puntuado en ninguna categoría activa de ese eje. Nunca es una F,
  porque una puntuación ausente no es una mala puntuación.

### Qué significan `needs_api` y `manual_review`

Algunas comprobaciones no se pueden verificar desde el HTML estático. Una comprobación que necesita un
nivel de datos superior (un renderizador, `PSI_API_KEY`, Search Console) es `needs_api`; una que
necesita juicio humano (¿esta afirmación es «fuerte»? ¿esta fuente es autorizada?) es
`manual_review`. Ambas quedan **excluidas del cálculo de la puntuación** y se cuentan por separado
como confianza de la puntuación, de modo que una puntuación alta respaldada por muchas comprobaciones
no verificables se reporta con honestidad en lugar de inflarse. Ninguna es nunca una aprobación
silenciosa.

## Sondas: se informan, nunca se puntúan

Dos entradas opcionales viven **junto a** la puntuación y nunca dentro de ella.

**`--probe "<question>"`** (repetible) ejecuta una `WebSearch` por pregunta, lee los resultados
orgánicos en orden y se los pasa a `scripts/probe-report.mjs`, que devuelve tasa de presencia, mejor
posición, un recuento de hosts competidores y una tendencia frente a sondas anteriores de ese host. El
hallazgo es `M14.probe.web_presence`, **severidad 0**. El script emite una advertencia que la skill
cita textualmente en lugar de parafrasear: esto es presencia en búsqueda web, no datos de citación de
AI Overviews / AI Mode / ChatGPT / Perplexity, porque ningún proveedor los expone. La indexación es
una *precondición* documentada para las funciones de IA de Google: la presencia aquí es necesaria, no
suficiente.

**`--gsc-ai-export <csv>`** importa una exportación de rendimiento de **IA generativa** de Search
Console que descargaste a mano (no existe API para ella). Se reconocen cabeceras de columna en inglés
y en español. El informe lleva **solo impresiones** — sin clics, sin citaciones, sin atribución por
respuesta — porque es todo lo que Google expone. Hallazgos `M14.gsc_ai.impressions_present`,
`.zero_impressions` y `.unavailable`, todos de **severidad 0**.

Si preguntas «¿subió mi visibilidad en IA?», la respuesta honesta es que estos datos son
aproximaciones y la puntuación es una evaluación estructural. Se informan por separado justamente por
eso.

## El corrector opcional

`fix` lleva `disable-model-invocation: true`: el modelo **nunca** puede activarlo. Solo tú, al
ejecutar `/claude-seo-ai:fix`. Las escrituras pasan por el único subagente `seo-fixer-writer` (el
único agente con Write/Edit; todos los auditores son de solo lectura por su lista de herramientas
permitidas).

**La postura por defecto es el dry-run.** Si no pediste aplicar con claridad, se trata como una
simulación.

### El flujo

1. **Carga el informe, nunca desde la memoria.** Cada cambio proviene de un `report.json` persistido
   en disco (`--report <path>`, si no `--run <id>`, si no la última ejecución de ese objetivo). Si el
   informe falta o tiene más de 24 h, se te avisa y se te ofrece reauditar primero. Los hallazgos
   nunca se reconstruyen a partir de la conversación.
2. **Confirma el perfil de plataforma.** Cuando la confianza de plataforma está por debajo de `high`,
   o `--target auto` deja más de una ruta de escritura plausible, ves qué se detectó —con las
   señales— y lo confirmas o lo corriges. Un perfil equivocado escribe en la superficie equivocada.
3. **Comprueba la preparación.** Las credenciales se vuelven a comprobar **en el entorno donde se
   ejecuta la corrección**, no contra la marca `ready` que la auditoría congeló en `profile.json`:
   exporta las claves (o rellena las opciones de `/plugin`) y `--target auto` reconoce el adaptador
   en la siguiente ejecución, sin volver a auditar. El plan imprime una línea por adaptador —listo /
   no listo, las claves que necesita y las que siguen faltando, **solo por nombre**—. Después, la
   operación `capabilities` de cada adaptador informa qué puede hacer. Una clave ausente degrada ese
   destino a `instructions`; nunca detiene la ejecución. (La detección de herramientas —un binario
   `shopify` o `wp` en el `PATH`— sigue viniendo del perfil de la auditoría.)
4. **Planifica.** Una sola llamada a `fix-plan.mjs` agrupa los hallazgos corregibles del informe según
   el adaptador dueño de cada superficie y escribe `plan.json` + `manifest.json`. Las entradas del
   mundo real sin resolver —un mapa de locales, URLs de perfil para `sameAs`, el preset de robots, el
   destino de una redirección, una fecha de publicación— se preguntan en el chat y se devuelven con
   `--answers`. Nunca se inventan, y un marcador `TODO:<field>` jamás llega a una escritura.
5. **Previsualiza.** Cada cambio se renderiza y se etiqueta con su impacto en vivo: `[none]` (un
   archivo o un tema en staging), `[staged]` (una superficie de borrador, invisible para las visitas),
   `[LIVE]` (visible de inmediato). Los archivos llevan un unified diff; los cambios por API llevan la
   petición, las variables y los valores `before`; las operaciones de CLI llevan el comando exacto.
   Los cambios de tema de Shopify llevan además su resultado de `theme check`, y un error ahí bloquea
   la aplicación.
6. **Se detiene con `--dry-run`.** Se imprime el resumen, no se escribe nada, listo.
7. **Confirmas y se emiten tickets.** Aceptas cambio por cambio o por lote —tú decides— y la
   confirmación nombra el impacto en vivo de lo que estás aceptando. Cada cambio aceptado recibe un
   ticket de confirmación de un solo uso y 15 minutos de vigencia, emitido en el mismo turno que tu
   «sí».
8. **El escritor se ejecuta una vez.** Un solo despacho a `seo-fixer-writer` con los ids confirmados y
   sus tickets. `--publish` necesita una **segunda** confirmación y su **propio** ticket, porque
   publicar es lo que hace visible el trabajo en staging.
9. **Verifica.** Cada cambio aplicado se vuelve a verificar, junto con el `verification.reproduce` del
   propio hallazgo. Una caché de CDN o de página desactualizada se reporta como `pending_cache`,
   **nunca** como aprobado. Un proyecto local sin servidor de desarrollo se verifica solo a nivel de
   código fuente, y así lo dice.
10. **Informa.** Cambio · destino · impacto en vivo · estado · verificación, y luego qué queda en
    staging, las salvedades de caché, el comando de rollback y los elementos de `instructions` que aún
    tienes que hacer clic por clic.

### Cobertura: nada se descarta en silencio

El plan da cuenta de **todos** los hallazgos del informe, así que un plan nunca puede imprimir
«2 cambios» sobre un informe de 30 hallazgos y no decir nada de los otros 28:

```
findings 127 · actionable 86 · considered 11 · planned 11 (auto 0 · proposed 11)
skipped proposed 37   → re-run with --include-proposed to plan them
advisory 6            → never written by this tool; a person decides
unroutable 0          → considered but owned by no adapter
by adapter: local-files 7 considered / 0 planned · instructions 11 considered / 11 planned
```

`planned ⊆ considered`, y `unroutable = considered − planned`. El mismo objeto aparece en el resultado
del CLI, en `plan.json` como `plan.coverage`, en cada grupo y en `manifest.counts`.

### `--category` son ids de módulo, no temas

`--category` coincide con el **id de módulo** de un hallazgo (`M5`, `M7`, `M17`, …), su **eje**
(`search`, `ai` o `both`, que coincide con los otros dos), su **clase de corregibilidad** (`auto`,
`proposed`, `advisory`) o su **alcance** (`page`, `site`, …), sin distinguir mayúsculas. **No** separa
por comas: repite la bandera para ampliar el filtro.

```
/claude-seo-ai:fix https://example.com --category M5 --category M17   # schema + sitemaps
/claude-seo-ai:fix https://example.com --category auto                # only the safe class
```

### Qué puede y qué no puede escribir

| Clase | Ejemplos | Comportamiento |
|---|---|---|
| **AUTO** | meta `viewport`/`charset`/`<html lang>`, JSON-LD de Tier 1, presets de IA en robots.txt + `Sitemap:`, canonical autorreferencial, conjuntos de hreflang, tarjetas OG/Twitter, `width`/`height` de imágenes, entradas de sitemap XML, `llms.txt` (sujeto a divulgación, puntúa 0) | Se escribe tras el diff + confirmación |
| **PROPOSED** | `<title>` / meta description generados, reescrituras de bloques de respuesta y TL;DR, inserciones de enlaces internos, reestructuración de encabezados, texto alternativo de imagen generado | Requiere aceptación por elemento; se retiene por completo sin `--include-proposed` |
| **ADVISORY** | reescrituras de contenido y E-E-A-T, estadísticas o citas añadidas, Core Web Vitals, estrategia de renderizado, redirecciones y códigos de estado, link-building, datos de backend de Merchant Center / Perfil de Empresa | **Nunca se escribe** |

Solo las estrategias de inserción `html-head`, `front-matter`, `config-file` y `liquid` pueden generar
un cambio AUTO. Todas las estrategias de JSX/TS son PROPOSED, y nada en esta herramienta reescribe JSX
con expresiones regulares.

### Nunca en vivo por defecto

Por plataforma, y aplicado por los adaptadores en lugar de por la prosa: consulta
[`platforms.md`](platforms.md#qué-nunca-se-publica-en-vivo-por-defecto) para la lista completa. En
resumen: Shopify sube a un tema sin publicar y un push en vivo desde el shell es un rechazo duro en el
hook `guard-bash`; los cambios de Webflow y HubSpot quedan en staging hasta una publicación con su
propio ticket; Ghost nunca cambia `status` ni toca el cuerpo; WordPress nunca toca `status` ni el
contenido de las entradas; Wix y BigCommerce no tienen superficie de staging, así que sus cambios se
etiquetan `[LIVE]` antes de que se te pregunte.

### Rollback

```
/claude-seo-ai:fix --rollback <run_id>
```

Lee `<DATA>/fix/runs/<run_id>/manifest.json`, muestra qué se restauraría —archivos locales desde
`<DATA>/backups/<run_id>/`, recursos remotos desde `before/*.json` y `previous_live_id` para un tema
publicado—, pregunta y solo entonces restaura. Un cambio nunca retrocede en su máquina de estados, así
que el manifiesto se puede reproducir con honestidad.

### Otras garantías de seguridad

- **Consciente de Git** (*protocolo del escritor, no código*): `skills/seo-fix-apply` indica al
  subagente escritor que ejecute `git status --porcelain` antes de nada, rechace un working tree
  sucio salvo con `--force` y prefiera una rama `seo-fix/<date>`. Ningún adaptador ejecuta git: esta
  regla se cumple porque el escritor sigue su protocolo, a diferencia de las garantías siguientes,
  que se cumplen haga lo que haga el modelo.
- **Idempotente**: cada cambio lleva un marcador o una comprobación de existencia, así que volver a
  ejecutarlo produce `skipped_idempotent`, nunca un bloque duplicado.
- **Nunca toca** `.git/`, `.env*`, lockfiles, material de claves, `wp-config.php` ni un
  `config/settings_data.json` de Shopify. Dos hooks PreToolUse (`guard-write` para las herramientas de
  archivo, `guard-bash` para el shell) lo aplican con independencia del modelo.
- Las **credenciales** viven solo en el entorno: nunca en `argv`, nunca se imprimen, nunca se escriben
  en el repositorio y se redactan en el log de correcciones.
- **Sin fabricación**: sin estadísticas, citas, precios, valoraciones ni enlaces de identidad
  inventados, y sin antedatar `dateModified`.

> Los tickets de confirmación son un refuerzo procedimental, no un límite de capacidad: los hooks
> heredan el entorno de Claude Code. El verdadero respaldo es tu propia confirmación de permisos de
> Bash — nunca pongas en la lista de permitidos `Bash(shopify:*)`, `Bash(wp:*)` ni `Bash(ssh:*)`.

## Credenciales

Los adaptadores leen primero `CLAUDE_PLUGIN_OPTION_<KEY>` (lo que exporta un `userConfig` del plugin)
y después la variable `<KEY>` a secas del entorno. Así que, o bien:

- ejecutas **`/plugin`** → claude-seo-ai y rellenas los campos, o
- haces `export` de las claves en el shell que inicia Claude Code.

Deliberadamente **no existe ninguna bandera `--key`**: un secreto en la línea de comandos queda en
`ps`, en el historial del shell y en cualquier registro de comandos, y estos scripts imprimen el
comando para reproducir la ejecución. Claves por plataforma y para qué sirve cada una:
[`platforms.md`](platforms.md#credenciales).

## Los scripts, directamente

Los helpers de Node sin dependencias (Node ≥ 18, sin paso de instalación) son la capa de adquisición,
y todos se pueden ejecutar a mano. Eso es lo que hace que el `verification.reproduce` de cada hallazgo
sea un comando real.

```bash
# Acquire one page into a run directory
node scripts/snapshot.mjs https://example.com --out ./runs --render auto --json

# Crawl a site (robots-respecting, template-sampled)
node scripts/crawl.mjs https://example.com --out ./runs --pages 12 --per-template 2 --depth 3

# The whole deterministic pipeline: acquire → profile → checks → report
node scripts/audit.mjs https://example.com --out ./runs --pages 5 --format json

# Re-run the checks over an existing run without re-crawling
node scripts/audit.mjs <run-dir> --checks deterministic --format md

# Score and compare
node scripts/score.mjs   --run <run-dir>
node scripts/compare.mjs --baseline latest --against <run-dir> --format md

# Point checks at anything
node scripts/detect-platform.mjs --url https://example.com --probe
node scripts/validate-jsonld.mjs --snapshot <run>/pages/<slug>.json
node scripts/ai-eligibility.mjs  --snapshot <run>/pages/<slug>.json
node scripts/acp-feed-lint.mjs   --feed ./products.jsonl --strict
```

Ninguno de los scripts tiene bandera `--help`. Ejecuta cualquiera sin argumentos e imprimirá su línea
de uso; el bloque de comentarios al inicio de cada archivo es el contrato completo.

**Los códigos de salida son uniformes:** `0` ok · `1` invocación incorrecta · `2` error en tiempo de
ejecución · `3` se activó un umbral o una compuerta.

## CI

`action.yml`, en la raíz del repositorio, es una GitHub Action compuesta que ejecuta el mismo
subconjunto determinista (los módulos que juzga el modelo necesitan Claude Code, así que las dos
puntuaciones en CI describen lo que un script puede probar, no todo lo que cubre la auditoría
completa).

```yaml
- id: seo
  uses: Hainrixz/claude-seo-ai@v0.2.0
  with:
    url: https://example.com
    pages: '5'
    render: static
    lang: en
    fail-under-search: '70'
    fail-under-ai: '60'
    fail-on-gated: 'true'

- run: echo "Search ${{ steps.seo.outputs.search-score }} (${{ steps.seo.outputs.search-band }})"
```

Entradas: `url` (obligatoria), `pages`, `max`, `render`, `lang`, `environment`, `vertical`,
`fail-under-search`, `fail-under-ai`, `fail-on-gated`, `fail-on-severity`, `out`, `node-version`,
`upload-artifact`, `artifact-name`.
Salidas: `search-score`, `ai-score`, `search-band`, `ai-band`, `report-json`, `report-md`, `run-dir`,
`exit-code`.

El resumen del job se escribe en `$GITHUB_STEP_SUMMARY`, el directorio de la ejecución se sube como
artefacto por defecto, y una compuerta activada termina con código 3 y emite una anotación `::error`
por cada compuerta. Hay un workflow listo para copiar en
[`.github/workflows/seo-audit-example.yml`](../../.github/workflows/seo-audit-example.yml).
