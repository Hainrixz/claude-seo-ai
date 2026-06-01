# Uso

Una guía práctica para ejecutar `claude-seo-ai`: instalarlo, ejecutar los cuatro
comandos, leer el informe de doble puntuación y aplicar correcciones de forma segura.

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

> Publicado en `github.com/Hainrixz/claude-seo-ai`. El plugin
> funciona totalmente sin conexión (Tier 0): no se requieren claves. El renderizado
> JS opcional y los datos de campo de Core Web Vitals residen en Tier 1+ (consulta
> Niveles de datos en el README).

## Los cuatro comandos

`claude-seo-ai` incluye **cuatro comandos (skills)**: `audit`, `geo`, `score` y
`fix`. No hay enrutador raíz ni análisis de subcomandos: cada uno es su propio
comando de nivel superior. Como las skills de los plugins de Claude Code siempre
tienen espacio de nombres, el nombre del plugin (`claude-seo-ai`) es el espacio de
nombres, por lo que cada comando se invoca como `/claude-seo-ai:<command>`. El
`target` es una URL (`https://…`) o una ruta local (un proyecto web o HTML compilado).

```
/claude-seo-ai:audit <url|path> [--render auto|static|js] [--vertical auto|saas|blog-publisher|local-business|ecommerce|docs]
/claude-seo-ai:geo   <url|path>
/claude-seo-ai:score
/claude-seo-ai:fix   <url|path> [--category schema|meta|robots|sitemap|hreflang|alt|canonical|social|llms] [--dry-run]
```

| Comando | Qué hace | ¿Escribe archivos? |
|---|---|---|
| `audit` | Auditoría completa de solo lectura en ambos ejes; fusiona los hallazgos; puntúa. | No, nunca |
| `geo` | Subconjunto de búsqueda con IA (GEO/AEO) → puntuación de Visibilidad en IA + informe de citabilidad. | No |
| `score` | Recalcula/muestra las dos puntuaciones a partir de los hallazgos de la auditoría más reciente. | No |
| `fix` | Corrector opcional (opt-in); previsualiza diffs y escribe solo tras tu confirmación. | Solo al confirmar |

`audit`, `geo` y `score` son de solo lectura y pueden activarse por descripción.
`fix` tiene `disable-model-invocation: true`: solo **tú** puedes invocarlo, y el
modelo nunca lo activa automáticamente.

### `audit`

De solo lectura. Invoca la skill `seo-orchestrator`, que construye un único
PageSnapshot compartido, detecta el vertical, despacha en paralelo los subagentes
especialistas de solo lectura, fusiona los hallazgos y puntúa. Nunca toca tus archivos.

```
# Auditar una URL en vivo
/claude-seo-ai:audit https://example.com

# Auditar un fixture incluido (HTML local)
/claude-seo-ai:audit tests/fixtures/blog-post.html

# Forzar el renderizado JS para una SPA y tratarla como e-commerce
/claude-seo-ai:audit https://example.com --render js --vertical ecommerce
```

Obtienes: ambas puntuaciones con sus bandas e interpretaciones de una línea, un
desglose por categoría, el nivel de datos alcanzado, el recuento de comprobaciones
`needs_api` y una lista de correcciones priorizada y ordenada por impacto ÷ esfuerzo.
Cada elemento incluye estado, evidencia, recomendación, corregibilidad
(auto/proposed/advisory) y `expected_impact`. Termina ofreciendo ejecutar `fix`.

### `geo`

Solo el subconjunto de búsqueda con IA: extractabilidad de respuestas (M11),
densidad de hechos (M12), acceso de rastreadores de IA + llms.txt (M14/M21),
enlazado de entidades (M6), más schema (M5) y renderizado (M4), ya que alimentan la
visibilidad en IA. Puede despachar el subagente `ai-search-geo-specialist`. Informa
de la puntuación de **Visibilidad en IA** (banda + interpretación) y de un desglose
de citabilidad por categoría.

```
/claude-seo-ai:geo https://example.com
```

> Nota: `llms.txt` se reporta pero **puntúa 0** y se etiqueta con impacto
> bajo/incierto (~10% de adopción; soporte parcial de los proveedores: Anthropic y
> Perplexity lo respetan, Google no lo usa para AI Overviews/AI Mode, OpenAI sin
> compromiso; también es útil como contexto para agentes de IDE).

### `score`

Recalcula y muestra las dos puntuaciones a partir de la auditoría más reciente de
esta sesión, volviendo a ejecutar la skill `seo-score` (que usa `scripts/score.mjs`
para obtener un número reproducible). Pasa un JSON de hallazgos guardado para puntuar
ese archivo en su lugar. Si no existe ninguna auditoría previa, ejecuta `audit` primero.

```
# Recalcular a partir de la última auditoría
/claude-seo-ai:score

# Puntuar un archivo de hallazgos guardado
/claude-seo-ai:score findings.json
```

### `fix`

Corrector opcional (opt-in): se detalla más abajo.

```
/claude-seo-ai:fix tests/fixtures/blog-post.html --category schema,meta
```

## Lectura del informe de doble puntuación

Dos puntuaciones **independientes** de 0 a 100, nunca combinadas en una sola. Una
página puede posicionar bien en Google y aun así no ser citable por los motores de
IA, o al revés.

| Puntuación | Ponderada hacia |
|---|---|
| **Search SEO** | indexabilidad, Core Web Vitals, on-page, schema |
| **AI Visibility (GEO/AEO)** | extractabilidad de respuestas, schema, densidad de hechos, acceso de rastreadores de IA, entidades |

Cada puntuación tiene una banda con letra (A–F) y una interpretación de una línea. Notas:

- El **gating por severidad** limita una puntuación a F si algo crítico falla
  (p. ej. un `noindex` en todo el sitio).
- Los **verticales condicionales** se renormalizan para que un blog no sea
  penalizado por carecer de schema de Product.
- Cada hallazgo lleva un nivel de `confidence` (`established` / `directional` /
  `speculative`); las directrices filtradas o inferidas (p. ej. NavBoost) se
  entregan solo como `directional`.

### Qué significa `needs_api`

Algunas comprobaciones no se pueden verificar sin conexión: necesitan una
integración de Tier 1+ (un MCP de renderizado, `PSI_API_KEY` o Search Console). Se
marcan como `needs_api`. Quedan **excluidas del cálculo de la puntuación** y se
cuentan por separado como **confianza de la puntuación** (score confidence), de modo
que una puntuación alta respaldada por muchas comprobaciones no verificables se
reporta con honestidad en lugar de inflarse. Aportar la clave/MCP pertinente
(consulta Niveles de datos en el README) las convierte en hallazgos reales.

## El corrector opcional (flujo dry-run / confirmación)

El comando `fix` tiene `disable-model-invocation: true`: el modelo **nunca** puede
desencadenar escrituras por su cuenta. Solo tú lo haces, al ejecutar
`/claude-seo-ai:fix`, y las escrituras pasan por el único subagente
`seo-fixer-writer` (el único agente con Write/Edit; todos los auditores son de solo
lectura por la lista de herramientas permitidas).

**El dry-run (solo previsualización) es el comportamiento por defecto.** El flujo:

1. Toma los hallazgos (la última auditoría o una nueva) y los filtra a
   `fixable: auto` (más `proposed` si lo activas). `--category` acota qué clases se
   aplican.
2. Para cada uno, localiza el punto de inserción exacto y construye un **unified
   diff** (o el contenido de un archivo nuevo). Cualquier dato del mundo real
   (p. ej. URLs de `sameAs`, mapa de locales, fechas de publicación) **se te
   solicita**: nunca se inventa.
3. **Dry-run**: imprime cada diff agrupado por archivo, no escribe nada y resume qué
   cambiaría al quitar `--dry-run`.
4. Solo con confirmación explícita: delega en `seo-fixer-writer` para aplicar. La
   confirmación por cambio o por lote es decisión tuya.

```
# Previsualizar (por defecto): no se escribe nada
/claude-seo-ai:fix tests/fixtures/blog-post.html

# Acotar a schema + meta, sigue siendo solo previsualización
/claude-seo-ai:fix https://example.com --category schema,meta --dry-run

# Aplicar (quita --dry-run y luego confirma cada cambio cuando se te pida)
/claude-seo-ai:fix https://example.com --category meta
```

### Qué puede y qué no puede escribir

| Clase | Ejemplos | Comportamiento |
|---|---|---|
| **AUTO** | meta `viewport`/`charset`/`<html lang>`, JSON-LD de Tier 1, directivas de IA en robots.txt + `Sitemap:`, canonical, conjuntos de hreflang, tarjetas OG/Twitter, `width`/`height` de imágenes, entradas de sitemap XML, `llms.txt` (sujeto a divulgación) | Se escribe con diff + confirmación |
| **PROPOSED** | `<title>`/meta description generados, reescrituras de bloque de respuesta/TL;DR, inserciones de enlaces internos, reestructuración de encabezados, texto alternativo de imagen generado | Requiere aceptación por elemento |
| **ADVISORY** | reescrituras de contenido/E-E-A-T, Core Web Vitals/rendimiento, estrategia de renderizado, redirecciones, link-building, Merchant Center/GBP | **Nunca se escribe** |

### Garantías de seguridad

- Dry-run por defecto; escribir requiere quitar `--dry-run` y confirmar.
- **Consciente de Git**: rechaza un working tree sucio salvo con `--force`; prefiere
  una rama.
- **Copias de seguridad** de cada archivo antes de la primera modificación en
  `${CLAUDE_PLUGIN_DATA}/backups/<timestamp>/<path>`.
- **Idempotente**: volver a ejecutar `fix` no produce nuevos diffs una vez aplicado.
- **Reverifica** cada cambio (p. ej. mediante `scripts/validate-jsonld.mjs`) e
  informa de aprobado/fallido.
- **Nunca toca** `.git/`, `.env`/secretos, lockfiles ni archivos fuera de la raíz
  del proyecto (lo aplica un hook PreToolUse).
- **Sin fabricación**: nunca escribe estadísticas, citas, fechas (sin antedatar
  `dateModified`), credenciales ni enlaces de identidad inventados.

## Scripts auxiliares opcionales

Las skills funcionan como Markdown puro; los helpers de Node sin dependencias
(Node ≥ 18, sin paso de instalación) afinan la precisión y hacen que cada
`verification.reproduce` sea ejecutable:

```
node scripts/parse-html.mjs           --file tests/fixtures/blog-post.html
node scripts/validate-jsonld.mjs      --url  https://example.com
node scripts/parse-robots-sitemap.mjs --url  https://example.com
node scripts/score.mjs                --findings findings.json
```
