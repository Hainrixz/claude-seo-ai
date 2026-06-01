# Arquitectura

`claude-seo-ai` es un plugin de Claude Code que audita y (de forma opcional) corrige el **SEO de búsqueda** clásico y la **visibilidad en búsqueda con IA (GEO/AEO)** de cualquier sitio web o base de código web. Este documento describe el diseño **actual**.

## Puntos de entrada: cuatro skills de comando

No hay una skill raíz ni un enrutador de subcomandos. El plugin expone **cuatro skills de comando** directamente bajo `skills/`, cada una invocada como un comando de barra con espacio de nombres (el nombre del plugin `claude-seo-ai` es el espacio de nombres):

| Comando | Skill | Propósito | ¿Escribe? |
|---|---|---|---|
| `/claude-seo-ai:audit` | `audit` | Auditoría completa de solo lectura de SEO + búsqueda con IA → dos puntuaciones + informe priorizado | No |
| `/claude-seo-ai:geo` | `geo` | Subconjunto de búsqueda con IA (GEO/AEO) → puntuación de Visibilidad en IA + desglose de citabilidad | No |
| `/claude-seo-ai:score` | `score` | Recalcula/vuelve a mostrar las dos puntuaciones a partir del JSON de hallazgos más reciente (o uno guardado), sin volver a rastrear | No |
| `/claude-seo-ai:fix` | `fix` | Aplica correcciones seguras y deterministas tras una confirmación explícita por cambio | Sí (con restricciones) |

`fix` incluye **`disable-model-invocation: true`** en su frontmatter: el modelo **nunca** puede activarla automáticamente. Solo se ejecuta cuando el usuario escribe `/claude-seo-ai:fix`. Las otras tres son de solo lectura y pueden ser invocadas por el modelo.

## Modelo de tres capas

```
Layer 1  DIRECTIVE      audit · geo · score · fix              (the four command skills)
                                   |
                                   v
Layer 2  ORCHESTRATION   seo-orchestrator
            detect vertical -> dispatch read-only subagents (parallel)
            -> merge findings -> seo-score -> render report
                                   |
                                   v
Layer 3  EXECUTION       ~21 seo-* audit modules (M1..M21)
            + seo-crawl-render (PageSnapshot), seo-vertical-detect, seo-score
            + optional zero-dependency Node scripts (scripts/*.mjs)
```

**Capa 1 — Directiva.** Las skills de comando son ligeras. `audit` y `geo` entregan el objetivo y las banderas a `seo-orchestrator`; `score` vuelve a ejecutar `seo-score` sobre los hallazgos existentes; `fix` ejecuta el flujo de trabajo del corrector. Cada una asigna una intención del usuario al trabajo y luego renderiza los resultados en el idioma del usuario (EN/ES).

**Capa 2 — Orquestación.** `seo-orchestrator` coordina toda la auditoría en tres fases — **detectar → despachar → sintetizar**:
1. Resuelve el objetivo (URL o ruta local), llama a `seo-crawl-render` para construir el **PageSnapshot** compartido, y luego a `seo-vertical-detect` para clasificar el sitio (consulta `references/routing.md`).
2. Despacha los subagentes especialistas de solo lectura **en paralelo** (un mensaje, múltiples llamadas `Task`) para que la salida intermedia verbosa quede aislada; cada uno recibe el PageSnapshot, el vertical detectado y sus módulos asignados.
3. Fusiona todos los hallazgos, elimina duplicados por `id` (conserva el estado más severo), ejecuta `seo-score` y renderiza el informe.

**Capa 3 — Ejecución.** ~21 módulos de auditoría `seo-*` (M1..M21) que evalúan cada uno una sola preocupación y emiten hallazgos. Las skills de apoyo `seo-crawl-render`, `seo-vertical-detect` y `seo-score` también pertenecen a la Capa 3. Los módulos pueden invocar **scripts opcionales de Node sin dependencias** bajo `scripts/` (p. ej. `validate-jsonld.mjs`, `check-answerblocks.mjs`, `factdensity.mjs`, `hreflang-check.mjs`, `link-graph.mjs`, `parse-robots-sitemap.mjs`, `psi-client.mjs`, `score.mjs`) para obtener resultados reproducibles y verificables en CI. La auditoría sigue funcionando sin conexión (Nivel 0) sin ellos.

## PageSnapshot compartido

`seo-crawl-render` construye **un único** `PageSnapshot`, obtenido una sola vez, que cada módulo lee. Construirlo una sola vez es lo que hace posible la auditoría sin conexión (Nivel 0).

```
PageSnapshot {
  target:       { kind: "url"|"path", value }
  status_chain: [ { url, status, location? } ]      // redirects + final status
  headers:      { ... }                              // incl. X-Robots-Tag, content-type, hreflang Link
  raw_html:     "..."                                // pre-JS HTML the crawler/AI sees first
  rendered_dom: "..." | null                         // post-JS DOM, null if no render MCP
  render:       { needed, used, confidence }         // confidence: high | reduced
  artifacts:    { robots_txt, sitemaps[], llms_txt }
  tier:         0 | 1 | 2
}
```

**Decisión de renderizado:** `--render static` nunca renderiza; `--render js` siempre lo intenta; `--render auto` (por defecto) marca el renderizado del lado del cliente cuando `raw_html` está casi vacío, tiene marcadores de hidratación (`__NEXT_DATA__`, `window.__NUXT__`, `data-reactroot`, una única raíz `<div id="app">`), o le falta el contenido principal. Si se necesita renderizado y hay un MCP de renderizado (Playwright/Firecrawl) disponible, captura `rendered_dom` (`confidence: high`); si no, deja `rendered_dom: null`, fija `confidence: reduced` y emite un hallazgo M4 honesto en lugar de fingir que vio el contenido renderizado.

**Niveles:** `0` = solo WebFetch · `1` = MCP de renderizado y/o PageSpeed disponible · `2` = Search Console / Merchant disponible. Los módulos posteriores marcan un hallazgo como `needs_api` cuando requiere un nivel superior al alcanzado, nunca una aprobación silenciosa.

## Subagentes

Cinco subagentes, definidos en `agents/`. Cuatro son estrictamente de **solo lectura** (sin `Write`/`Edit`), de modo que una auditoría nunca puede modificar archivos. Solo `seo-fixer-writer` puede escribir, y únicamente a través de la skill `fix` tras una confirmación.

| Subagente | Herramientas | Rol | Módulos |
|---|---|---|---|
| `technical-auditor` | Read, Grep, Glob, Bash, WebFetch | SEO técnico | M1, M2 (+M3), M4, M7/M7b/M7c, M8, M9, M10, M15, M17 |
| `content-eeat-analyst` | Read, Grep, Glob, WebFetch | E-E-A-T + frescura | M13, M16 |
| `ai-search-geo-specialist` | Read, Grep, Glob, WebFetch | GEO/AEO | M6, M11, M12, M14, M21 |
| `schema-generator` | Read, Grep, Glob, Bash | Valida + propone JSON-LD (solo diffs) | M5 (+ esquema M18/M19 cuando está activo) |
| `seo-fixer-writer` | Read, Edit, Write, Bash | **El único que escribe** — aplica correcciones AUTO | usado por `fix` tras la confirmación |

`schema-generator` propone diffs pero no escribe; la escritura real siempre pasa por `seo-fixer-writer`.

## Enrutamiento por vertical

`seo-vertical-detect` clasifica el objetivo como `ecommerce`, `local-business`, `blog-publisher`, `saas`, `docs` o `generic` (un sitio puede coincidir con varios). El orquestador entonces ejecuta los módulos **siempre activos** (M1–M17, M21) más los módulos **condicionales** que el vertical desbloquea — M18 (comercio electrónico), M19 (local), M20 (internacional, cuando hay >1 configuración regional o `hreflang`) — y el evaluador vuelve a normalizar los pesos para que una categoría inactiva nunca penalice al sitio. Tabla completa en `references/routing.md`.

## Dos puntuaciones, nunca mezcladas

`seo-score` produce **dos puntuaciones independientes de 0 a 100** que nunca se promedian: **SEO de búsqueda** y **Visibilidad en IA (GEO/AEO)**. Una página puede posicionarse bien y aun así no ser citable por la IA, o viceversa — mostrar ambas es la tesis del producto.

- **Valor de categoría** = `100 × Σ(status_factor × severity) / Σ(severity)` sobre los hallazgos puntuados, donde `status_factor` es pass `1.0`, warn `0.5`, fail `0.0`. `needs_api` y `not_applicable` se excluyen de ambas sumas.
- **Puntuación** = `Σ(category_value × weight) / Σ(active weight)`; las categorías condicionales entran en el denominador solo cuando están activas, y luego los pesos se vuelven a normalizar.
- Un hallazgo contribuye únicamente a la(s) puntuación(es) nombrada(s) en su `expected_impact.axis` (`search`, `ai` o `both`).
- **Bandas:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.
- **Restricción por severidad:** cualquier hallazgo con `severity: 5` y `status: fail` (p. ej. `noindex` en todo el sitio, robots bloqueando a todos los rastreadores) **limita la puntuación afectada a ≤ 40** y fija `capped: true`.

El número se calcula de forma determinista mediante `scripts/score.mjs` (verificable en CI); un cálculo manual de respaldo sigue la misma fórmula en `references/scoring-model.md`.

## Contrato de hallazgos

Cada módulo emite hallazgos que cumplen con `schema/finding.schema.json`. El esquema prioriza la falsabilidad: cada hallazgo es observable y re-verificable de forma independiente. Los campos obligatorios incluyen `id` (con prefijo del módulo, p. ej. `M5.article.missing_datemodified`), `module`, `title`, `status` (`pass`/`warn`/`fail`/`not_applicable`/`needs_api`), `severity` (0–5), `scope`, `evidence.observed` (textual), `expected`, `recommendation`, `fixable`, `verification` (`method` + `assertion` + un `reproduce` ejecutable) y `expected_impact` (`axis` + `confidence` + `magnitude` + `rationale`).

`fixable` dirige el flujo de trabajo de `fix`:
- **auto** — determinista, aditivo, verificable por máquina (meta viewport/charset/lang, JSON-LD de Nivel 1, presets de robots para IA, hreflang, sitemaps, tarjetas OG/Twitter, dimensiones de imagen, canonical, `llms.txt`).
- **proposed** — modifica el texto/significado; requiere aceptación por elemento (títulos, meta descripciones, reescrituras de bloques de respuesta, texto alternativo generado).
- **advisory** — la herramienta nunca lo escribe (reescrituras de contenido/E-E-A-T, CWV/rendimiento, redirecciones, construcción de enlaces, datos del backend).

## Salvaguardas de honestidad

- **`llms.txt` se puntúa con 0** — se informa (M21) pero se excluye de la puntuación de Visibilidad en IA, porque el soporte de los proveedores es parcial y el impacto es incierto. Nunca mueve el número.
- Los datos estructurados de **FAQ/HowTo** se recomiendan para la comprensión por parte de las máquinas, no para los rich results que Google ha retirado.
- **Sin fabricación** — nunca inventar estadísticas, citas, fechas (sin retrodatar `dateModified`), credenciales ni vínculos de identidad; las entradas del mundo real (URLs de `sameAs`, mapas de configuración regional) se solicitan, nunca se adivinan.
- **Niveles de confianza** — `expected_impact.confidence` es `established`, `directional` o `speculative`; los hallazgos especulativos nunca limitan una puntuación por debajo de una banda. El impacto se expresa por bandas, nunca como un porcentaje fabricado y desnudo.
- **`needs_api`** nunca es una aprobación silenciosa; el informe enumera el nivel de datos alcanzado y el recuento de `needs_api` para que el usuario conozca la confianza de la puntuación.

## Seguridad de las correcciones (escritor opcional)

`fix` usa por defecto una **simulación (dry-run)** que imprime los diffs y no escribe nada. Escribir requiere que el usuario quite `--dry-run` y confirme. Es **consciente de git** (rechaza un árbol sucio sin `--force`, prefiere una rama), **respalda** cada archivo antes de la primera modificación, es **idempotente** (volver a ejecutarlo no produce nuevos diffs) y **vuelve a verificar** cada cambio reejecutando la `verification.assertion` del hallazgo. Nunca toca `.git/`, secretos, archivos de bloqueo ni archivos fuera de la raíz del proyecto.
