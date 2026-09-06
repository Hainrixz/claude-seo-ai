# Puntuación

`claude-seo-ai` informa de **dos puntuaciones independientes de 0 a 100** y **nunca las combina en un único número**. Comparten entradas, pero las ponderan de forma distinta. Una página puede posicionar bien y a la vez ser imposible de citar por una IA, o ser muy citable y posicionar mal: mostrar ambas es justamente el objetivo.

- **Puntuación de SEO de búsqueda** — cómo de bien preparada está la página para posicionar en los motores de búsqueda clásicos.
- **Puntuación de Visibilidad en IA (GEO/AEO)** — cómo de extraíble y citable es la página para los motores de respuesta basados en IA, y si siquiera es elegible (indexada + con snippet permitido).

El scorer es `scripts/score.mjs`. Es lógica pura (sin red) y totalmente reproducible: los mismos hallazgos siempre dan las mismas puntuaciones.

## Cómo se calcula una puntuación

Cada puntuación es una media ponderada de los valores de categoría sobre los pesos **activos**:

```
score = Σ(category_value × weight) / Σ(active weight)
```

El valor de una categoría es la tasa de aprobados ponderada por severidad de los hallazgos de esa categoría:

```
points(finding) = status_factor × severity
  status_factor: pass = 1.0, warn = 0.5, fail = 0.0
category_value = 100 × Σ points / Σ severity   (solo sobre los hallazgos puntuados)
```

| estado | factor | ¿se cuenta? |
|---|---|---|
| `pass` | 1.0 | sí |
| `warn` | 0.5 | sí |
| `fail` | 0.0 | sí (en el denominador) |
| `needs_api` | — | **excluido**; se cuenta en `needs_api_count` |
| `manual_review` | — | **excluido**; se cuenta en `manual_review_count` |
| `not_applicable` | — | **excluido** |
| cualquier estado con `severity: 0` | — | **excluido** (informativo) |

Un hallazgo solo contribuye a una puntuación cuando su `expected_impact.axis` coincide con esa puntuación (`search`, `ai` o `both`). Los módulos compartidos (M4, M5, M9, M13, M16, M18, M19) se puntúan de forma independiente en cada puntuación con el peso propio de esa puntuación. Los sufijos de módulo se normalizan al módulo padre (`M7b` → `M7`). Un hallazgo cuyo módulo no tiene categoría en su eje se lista en `unmapped_findings`: nunca se puntúa ni se descarta en silencio.

### `needs_api` y `manual_review` se excluyen, nunca se presuponen

Ambos estados se descartan antes de puntuar: **nunca cuentan como aprobado y nunca penalizan**. `needs_api` significa que faltaba una clave de API, un MCP o un renderizador; `manual_review` significa que una comprobación determinista no pudo decidir (por ejemplo, un idioma de página no soportado) y debe juzgar una persona o un modelo. Cada eje informa de `needs_api_count`, `manual_review_count` y `unscored_count` (todo lo que en ese eje no entró en la puntuación, por el motivo que sea) para que sepas qué parte del cuadro se midió realmente.

## SEO de búsqueda — pesos de categoría

| Categoría (`name` en la salida) | Descripción | Módulos | Peso | Activación |
|---|---|---|---|---|
| Indexability & Crawl | Indexabilidad y rastreo | M1, M2, M3 | 22 | siempre |
| Core Web Vitals / Performance | Core Web Vitals / rendimiento | M15 | 16 | siempre |
| On-Page & Meta | On-page y metadatos | M7 | 12 | siempre |
| Structured Data | Datos estructurados | M5 | 12 | siempre |
| Rendering | Renderizado | M4 | 8 | siempre |
| Internal Linking & Semantics | Enlazado interno y semántica | M10 | 8 | siempre |
| E-E-A-T | E-E-A-T | M16 | 7 | siempre |
| Images / Media | Imágenes / medios | M9 | 5 | siempre |
| Sitemaps & Discovery | Sitemaps y descubrimiento | M17 | 5 | siempre |
| Freshness | Frescura | M13 | 3 | siempre |
| Social Cards | Tarjetas sociales | M8 | 2 | siempre |
| E-commerce | Comercio electrónico | M18 | 15 | `vertical:ecommerce` |
| Local | Negocio local | M19 | 10 | `vertical:local-business` |
| International | Internacional (hreflang) | M20 | 8 | `flag:multilingual` |

## Visibilidad en IA (GEO/AEO) — pesos de categoría

Los pesos siempre activos suman 100.

| Categoría (`name` en la salida) | Descripción | Módulos | Peso | Activación |
|---|---|---|---|---|
| Answer Extractability | Extraibilidad de respuestas | M11 | 18 | siempre |
| AI Crawler Access | Acceso de rastreadores de IA y elegibilidad | M14 | 14 | siempre |
| Fact Density / Original Data | Densidad de hechos / datos originales | M12 | 14 | siempre |
| Structured Data | Datos estructurados | M5 | 12 | siempre |
| Rendering (non-JS) | Renderizado (sin JS) | M4 | 10 | siempre |
| Entity / Knowledge-Graph | Entidades / grafo de conocimiento | M6 | 9 | siempre |
| E-E-A-T / Authority | E-E-A-T / autoridad | M16 | 9 | siempre |
| Freshness | Frescura | M13 | 6 | siempre |
| Agent-readiness | Preparación para agentes | M22 | 4 | siempre |
| Images / Multimodal | Imágenes / multimodal | M9 | 4 | siempre |
| AI discovery & agent endpoints | Descubrimiento para IA y endpoints de agentes | M21 | **0** | siempre (se informa, nunca se puntúa) |
| Agentic commerce readiness | Preparación para comercio agéntico | M18 | 6 | `vertical:ecommerce` |
| Local / place data | Datos locales / de lugar | M19 | 5 | `vertical:local-business` |

**M21 tiene peso 0.** llms.txt, agents.md, el perfil UCP, el catálogo ARD y el sitemap agéntico se comprueban y se informan, pero ningún motor documenta que afecten a la citación, así que nunca mueven la puntuación de IA. Sus hallazgos aparecen en la lista de categorías y en `unscored_count`.

## Categorías condicionales y cómo se activan

Solo las categorías **activas** con **peso > 0** entran en el denominador. Cuando una categoría está inactiva, su peso se elimina y el resto se renormaliza, de modo que un blog nunca se penaliza por carecer de schema Product. Cada categoría informa de su `active_weight`: la parte (en %) del total activo que realmente aportó.

Una categoría condicional se activa de dos maneras:

1. **Declarada** — pasa `--vertical ecommerce,local-business`, `--multilingual` o `--vertical-json <archivo>` (la salida de `seo-vertical-detect`, o un `profile.json` con un objeto `vertical`). Es lo que hace la auditoría. En modo declarado, todo lo que no declaras queda apagado: los hallazgos de un módulo condicional inactivo se listan en `ignored_conditional[]` y nunca se puntúan, y una vertical declarada sin hallazgos puntuados produce un aviso.
2. **Inferida** (modo heredado, cuando no pasas ninguna bandera) — una categoría condicional se activa en cuanto tiene un hallazgo puntuado. La salida lo señala: `activation.source: "inferred"`, `activation.inferred_categories` y un aviso que te pide declarar la vertical.

Cada categoría emite `activation`: `always`, `vertical:ecommerce`, `vertical:local-business`, `flag:multilingual` o `inactive`.

## Calibración de la severidad

La severidad mide **cuánta elegibilidad o extraibilidad elimina el hecho observado**, no la importancia del módulo. Solo la severidad 5 puede topar una puntuación (ver más abajo).

| Severidad | Significado | Ejemplos |
|---|---|---|
| 5 | Catastrófica: mata la elegibilidad a nivel de sitio o plantilla | `noindex` en todo el sitio, robots.txt que bloquea a Googlebot, `nosnippet`/`max-snippet:0` en todo el sitio, shell solo CSR, robots.txt con 5xx |
| 4 | Mayor: una clase de páginas pierde elegibilidad o extraibilidad | `noindex` en una página clave, Product sin precio, robots que bloquea CSS/JS |
| 3 | Moderada: falta una señal documentada o fuertemente correlacionada | encabezado-pregunta sin respuesta directa, `dateModified` ausente, baja densidad de hechos, autor sin schema Person |
| 2 | Menor | aperturas anafóricas, `x-default` ausente, sin directiva `Sitemap:` |
| 1 | Cosmética | archivos de descubrimiento opcionales |
| 0 | Informativa: nunca se puntúa | sondas de búsqueda web, exportación de IA de GSC, `not_applicable` |

Hallazgos reasignados en v0.2.0: `M11.heading.no_direct_answer` 5→3, `M11.passage.unresolved_anaphora` 5→2, `M12.*` 4→3, `M6.*` 4→3, `M16.author.missing_person_schema` 4→3, `M4.render.jsonld_js_injected` 4→3, `M18.offer.missing_price` 5→4, `M18.offer.price_feed_mismatch` 5→3, `M18.facets.uncanonicalized` 5→3, `M1.sitemap.missing_directive` 5→2, `M1.robots.blocks_css_js` 5→4, `M20.hreflang.invalid_bcp47` 4→3, `M20.hreflang.missing_xdefault` 4→2.

## Bandas por letra y el estado `unscored`

| Banda | Rango |
|---|---|
| A | ≥ 90 |
| B | ≥ 80 |
| C | ≥ 70 |
| D | ≥ 60 |
| F | < 60 |
| `unscored` | ninguna categoría activa con peso > 0 |

Cuando nada de un eje pudo puntuarse — sin hallazgos, solo `needs_api`/`manual_review`, solo condicionales inactivas o solo módulos de peso 0 — el eje queda **sin puntuar** (`unscored`): `value: null`, `raw_value: null`, `band: "unscored"`, `state: "unscored"`. Un conjunto de hallazgos vacío nunca se informa como F.

## Cobertura y bandas provisionales

Una ejecución de una sola página puede producir una letra que parece firme a partir de una porción mínima del modelo, así que cada eje informa además cuánto de sí mismo se midió:

| Clave | Significado |
|---|---|
| `coverage` | % del peso **siempre activo** del eje que llevó al menos un hallazgo puntuado |
| `coverage_weight` / `coverage_total` | la misma cifra en pesos crudos (el bloque siempre activo suma 100) |
| `provisional` | `true` cuando `coverage` queda por debajo del piso (**50%**) |

Por debajo del piso el eje informa `state: "partial"` y un aviso que nombra las categorías no medidas. **La puntuación y la banda no cambian**: siguen siendo exactamente lo que produjeron los hallazgos, y la salvedad viaja junto a ellas. `report.md` muestra una columna de Cobertura, marca la banda provisional con `*` y repite el aviso en **Avisos**.

```
"ai_visibility": { "value": 100, "band": "A", "state": "partial", "provisional": true,
                   "coverage": 18, "coverage_weight": 18, "coverage_total": 100,
                   "warnings": ["coverage 18%: only 18 of 100 always-on weight on the ai axis carried a scored finding, …"] }
```

Amplía la ejecución (más páginas, un rastreo completo, una clave de PSI, los módulos que juzga el modelo) para subir la cobertura. Un eje con tope conserva `state: "capped"` y aun así informa `provisional`; un eje `unscored` nunca es provisional.

## Limitación por severidad (topes)

Una puntuación se topa en **40 (banda F)** solo cuando un hallazgo cumple **todas** estas condiciones:

1. `severity: 5` **y** `status: fail`;
2. `expected_impact.confidence: "established"` — un hallazgo `directional` o `speculative` nunca topa, por severo que sea;
3. su categoría está **activa con peso > 0** en ese eje — así que M21 (peso 0) y los módulos condicionales inactivos nunca topan.

La salida conserva ambos números: `raw_value` es el valor ponderado antes del tope y `value` es `min(raw_value, 40)`; `capped: true` y `state: "capped"` indican que el tope se aplicó (incluso cuando `raw_value` ya era ≤ 40), y `cap_reasons[]` lista cada hallazgo que lo provocó (`id`, `module`, `category`, `severity`, `status`, `confidence`, `scope`).

### Entornos que no son producción

Pasa `--environment preview|staging|local` (la auditoría lo toma de `profile.json`). En un host que no es de producción, los topes cuyo id coincide con `M2.*noindex*`, `M1.robots.*` o `M14.ai_eligibility.not_indexable` se **suprimen**: ahí el noindex y el bloqueo por robots son lo esperado. Pasan a `suppressed_caps[]` con el entorno y el motivo `expected on a non-production host`, y se añade un aviso. Cualquier otro fallo sev-5 `established` (por ejemplo, un shell solo CSR) sigue topando. El valor por defecto, `production`, nunca suprime.

### Las sondas nunca se puntúan

Las sondas de presencia en búsqueda web (`M14.probe.*`) y las importaciones de IA generativa de GSC (`M14.gsc_ai.*`) tienen severidad 0 y se informan bajo `probes` en `report.json`. Son un indicador aproximado, no datos de citación, y no pueden mover ni topar ninguna de las dos puntuaciones.

## Validación

Cada hallazgo se valida contra `schema/finding.schema.json` antes de puntuar. Los hallazgos inválidos se **descartan** y se listan en `dropped_findings[]` (`index`, `id`, `errors[]`); `dropped_count` aparece en el nivel superior y en ambos ejes. Usa `--strict` para que cualquier descarte termine con código 2 (CI) y `--validate-only` para comprobar un archivo de hallazgos sin puntuarlo.

## Interpretaciones Búsqueda-vs-IA

Alta = `value ≥ 75`, baja = `value < 60`. Cada puntuación lleva **su propia** `interpretation` de una línea (las cadenas se emiten en inglés):

| Cuadrante | Interpretación de Búsqueda | Interpretación de IA |
|---|---|---|
| Búsqueda alta / IA baja | Ranks well; classic fundamentals are strong. *(Posiciona bien; los fundamentos clásicos son sólidos.)* | Hard to cite by AI engines — add extractable structure and verify AI eligibility. *(Difícil de citar por motores de IA: añade estructura extraíble y verifica la elegibilidad para IA.)* |
| Búsqueda baja / IA alta | Foundational SEO issues to fix first. *(Problemas fundamentales de SEO que arreglar primero.)* | Citable by AI, but weak classic ranking limits reach. *(Citable por la IA, pero el posicionamiento clásico débil limita el alcance.)* |
| Ambas bajas | Foundational issues — fix indexability and structure first. *(Problemas fundamentales: arregla primero indexabilidad y estructura.)* | Foundational issues — add structure, schema, and answer blocks. *(Problemas fundamentales: añade estructura, schema y bloques de respuesta.)* |
| Ambas altas | Strong classic SEO; pursue depth and authority. *(SEO clásico sólido; busca profundidad y autoridad.)* | Strong AI visibility; keep content fresh and original. *(Visibilidad en IA sólida; mantén el contenido fresco y original.)* |
| Cualquier otra (mixta) | Mixed — see the prioritized actions. *(Mixta: consulta las acciones priorizadas.)* | Mixed — see the prioritized actions. |
| Eje sin puntuar | Unscored — no scored findings in an active Search category. | Unscored — no scored findings in an active AI category. |

Las puntuaciones entre 60 y 75 no son ni altas ni bajas, así que un par que no encaja claramente en un cuadrante es **mixto**. Cuando un eje está sin puntuar, el otro se interpreta según su propio nivel.

La tabla de arriba es la redacción en inglés. `report.mjs --lang es` (y `scoreFindings(..., { lang: 'es' })`) escribe esa misma línea, y todos los avisos que emite el puntuador, en español — un informe en español no debe imprimir frases en inglés bajo encabezados en español. El texto de los hallazgos (título, evidencia, recomendación) sigue en inglés: viene de las verificaciones, no del puntuador.

## Agregado de sitio (`--manifest`)

Con un manifiesto de rastreo (`crawl.json`), el scorer puntúa cada página muestreada y agrega los resultados en una puntuación de sitio:

1. Los hallazgos se deduplican (`id` + alcance + ubicación), de modo que un hallazgo de todo el sitio emitido por varias ejecuciones de página cuenta **una sola vez**.
2. Los hallazgos se asocian a páginas mediante `location.url` (host en minúsculas, sin hash, sin barra final), `location.file` / el `slug` de la página, o una pista `page` (url o slug; es una clave solo para el agregado y se elimina antes de validar). Los hallazgos con `scope: site` aplican a todas las páginas, los de `scope: template` a todas las páginas de esa plantilla; los hallazgos de página sin correspondencia se tratan como de todo el sitio, con un aviso.
3. Cada página recibe sus dos puntuaciones (así un tope de todo el sitio topa todas las páginas).
4. Una página que **no** respondió 2xx (404, 429, un 5xx) nunca se puntúa. Las verificaciones on-page se saltan una página que no es contenido, así que apenas acumularía hallazgos negativos y terminaría puntuando más alto que una página real. Se queda en `pages[]` con su `status`, `scorable: false` y `unscored_reason: "non_2xx_status"`, aparece en `unscored_pages[]` y en un aviso, no aporta peso al agregado y nunca sale en `worst_pages`. Un `status` en `null` (un archivo local) se puntúa con normalidad.
5. `valor del sitio = Σ w_página × valor_página / Σ w_página` sobre las páginas puntuadas. `w_página` sale de `manifest.pages[].weight` cuando existe y, si no, del rol de la página: **portada 3 · página objetivo 2 · primera muestra de cada plantilla 2 · cola larga 1**. Es el `method: "role_weights"`; la ponderación por impresiones de Search Console está prevista como `method: "gsc_impressions"`.
6. Una ejecución de **una sola página** no tiene agregado, así que una única URL auditada que respondió 404/429/5xx sigue reportando los dos ejes, pero solo a partir de hallazgos de nivel de sitio. El informe lleva entonces un aviso que lo dice tal cual: las puntuaciones no describen ninguna página.
7. El agregado está `capped` solo cuando todas las páginas puntuadas están topadas (un tope de todo el sitio); los topes de una sola página se cuentan en un aviso. `pages[]` lista el rol, el peso, el estado HTTP y las dos puntuaciones de cada página; `pages_scored` dice cuántas de `pages_count` entraron realmente en la media, y `worst_pages` da las tres páginas puntuadas más bajas por eje.

## Ejecutar el scorer

```bash
# un archivo de hallazgos, stdin o una ejecución persistida
node scripts/score.mjs --findings findings.json
cat findings.json | node scripts/score.mjs
node scripts/score.mjs --run ~/.claude-seo-ai/runs/example.com/latest        # lee <run>/findings.json

# declara la vertical (lo que hace la auditoría) en lugar de inferirla
node scripts/score.mjs --findings findings.json --vertical ecommerce,local-business --multilingual
node scripts/score.mjs --findings findings.json --vertical-json profile.json

# hosts de staging/preview: los topes por noindex/robots se suprimen y se informan
node scripts/score.mjs --findings findings.json --environment staging

# agregado de sitio a partir de un manifiesto de rastreo (hallazgos de --findings/--run, o los que lleva el manifiesto)
node scripts/score.mjs --run <run-dir> --manifest              # <run-dir>/crawl.json
node scripts/score.mjs --manifest crawl.json

# CI
node scripts/score.mjs --findings findings.json --strict        # código 2 si se descartó algún hallazgo
node scripts/score.mjs --findings findings.json --validate-only
```

La entrada es un array JSON de hallazgos, o `{ "findings": [...] }`, donde cada uno se ajusta a `schema/finding.schema.json`. Códigos de salida: `0` ok · `1` invocación incorrecta (sin entrada, archivo ilegible, JSON inválido, bandera incorrecta) · `2` `--strict` con hallazgos descartados.

## Forma de la salida

```json
{
  "findings_count": 7,
  "search_seo": {
    "value": 40, "band": "F", "capped": true, "needs_api_count": 1,
    "raw_value": 71.8, "state": "capped",
    "cap_reasons": [ { "id": "M2.robots.noindex_sitewide", "module": "M2", "category": "Indexability & Crawl", "severity": 5, "status": "fail", "confidence": "established", "scope": "site" } ],
    "suppressed_caps": [],
    "manual_review_count": 0, "unscored_count": 1, "dropped_count": 0,
    "warnings": [],
    "categories": [
      { "name": "Indexability & Crawl", "weight": 22, "value": 50, "active": true, "modules": ["M1", "M2", "M3"], "active_weight": 56.4, "activation": "always", "conditional": false, "scored": 2, "needs_api": 0, "manual_review": 0 }
    ],
    "interpretation": "Foundational SEO issues to fix first."
  },
  "ai_visibility": { "value": null, "band": "unscored", "state": "unscored", "...": "mismas claves" },
  "dropped_count": 0, "dropped_findings": [], "unmapped_findings": [], "ignored_conditional": [],
  "activation": { "source": "declared", "vertical": { "primary": "ecommerce", "also": [], "multilingual": false }, "environment": "production", "inferred_categories": [] },
  "warnings": []
}
```

Las claves heredadas (`value`, `band`, `capped`, `needs_api_count`, `categories[].name/weight/value/active`, `interpretation`) no cambian; todo lo demás es aditivo. Con `--manifest` el resultado incluye además `method`, `weights`, `pages_count`, `pages_scored`, `pages[]`, `unscored_pages[]`, `worst_pages` y `unassigned_count`. Ambos objetos de eje validan contra `$defs.score` en `schema/audit-report.schema.json`.
