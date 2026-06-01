# Puntuación

`claude-seo-ai` informa de **dos puntuaciones independientes de 0 a 100** y **nunca las combina en un único número**. Comparten entradas, pero las ponderan de forma distinta. Una página puede posicionar bien y a la vez ser imposible de citar por una IA, o ser muy citable y posicionar mal: mostrar ambas es justamente el objetivo.

- **Puntuación de SEO de búsqueda** — cómo de bien preparada está la página para posicionar en los motores de búsqueda clásicos.
- **Puntuación de Visibilidad en IA (GEO/AEO)** — cómo de extraíble y citable es la página para los motores de respuesta basados en IA.

## Cómo se calcula una puntuación

Cada puntuación es una media ponderada de los valores de categoría sobre los pesos **activos**:

```
score = Σ(category_value × weight) / Σ(active weight)
```

El valor de una categoría es la tasa de aprobados ponderada por severidad de los hallazgos de esa categoría:

```
points(finding) = status_factor × severity
  status_factor: pass = 1.0, warn = 0.5, fail = 0.0
category_value = 100 × Σ points / Σ severity   (over scored findings only)
```

Los factores de estado provienen directamente de la implementación:

| estado | factor | ¿se cuenta? |
|---|---|---|
| `pass` | 1.0 | sí |
| `warn` | 0.5 | sí |
| `fail` | 0.0 | sí (en el denominador) |
| `needs_api` | — | **excluido** tanto del numerador como del denominador |
| `not_applicable` | — | **excluido** tanto del numerador como del denominador |

Un hallazgo solo contribuye a una puntuación cuando su `expected_impact.axis` coincide con esa puntuación (`search`, `ai` o `both`). Los módulos compartidos (M4, M5, M9, M13, M16) se puntúan de forma independiente en cada puntuación con el peso propio de esa puntuación. Los sufijos de módulo se normalizan al módulo padre (p. ej. `M7b` → `M7`).

### Cómo se excluye `needs_api`

Los hallazgos `needs_api` (y `not_applicable`) se descartan antes de la puntuación: **nunca cuentan como aprobado y nunca penalizan**. Cada puntuación informa de `needs_api_count` para que sepas qué parte del cuadro requería una API que no conectaste. Una categoría cuyos hallazgos son todos `needs_api`/`not_applicable` no tiene hallazgos puntuados y, por tanto, está inactiva (ver la renormalización más abajo).

## SEO de búsqueda — pesos de categoría

| Categoría | Módulos | Peso |
|---|---|---|
| Indexability & Crawl | M1, M2, M3 | 22 |
| Core Web Vitals / Performance | M15 | 16 |
| On-Page & Meta | M7 | 12 |
| Structured Data | M5 | 12 |
| Rendering | M4 | 8 |
| Internal Linking & Semantics | M10 | 8 |
| E-E-A-T | M16 | 7 |
| Images / Media | M9 | 5 |
| Sitemaps & Discovery | M17 | 5 |
| Freshness | M13 | 3 |
| Social Cards | M8 | 2 |
| **Conditional** E-commerce | M18 | 15 |
| **Conditional** Local | M19 | 10 |
| **Conditional** International | M20 | 8 |

## Visibilidad en IA (GEO/AEO) — pesos de categoría

| Categoría | Módulos | Peso |
|---|---|---|
| Answer Extractability | M11 | 20 |
| Structured Data | M5 | 16 |
| Fact Density / Original Data | M12 | 14 |
| AI Crawler Access | M14 | 12 |
| Rendering (non-JS) | M4 | 10 |
| Entity / Knowledge-Graph | M6 | 10 |
| E-E-A-T / Authority | M16 | 9 |
| Freshness | M13 | 6 |
| Images / Multimodal | M9 | 3 |
| llms.txt | M21 | 0 (reported, **excluded from score**) |

`llms.txt` tiene peso `0`: se comprueba y se informa pero, como cualquier categoría de peso cero, nunca mueve la puntuación.

## Renormalización dinámica de las verticales condicionales

Solo las categorías que están **activas** y tienen **peso > 0** entran en el denominador. Una categoría está activa cuando tiene al menos un hallazgo puntuado en ese eje.

- Las verticales condicionales — **E-commerce (M18)**, **Local (M19)**, **International (M20)** — solo se activan cuando se detectan sus señales (p. ej. el schema Product/Offer o las rutas de carrito disparan e-commerce).
- Cuando una categoría está inactiva, su peso se elimina y los pesos restantes se renormalizan, de modo que la puntuación siempre se calcula sobre el total **activo**. Un blog nunca se penaliza por carecer de schema Product.

## Bandas por letra

| Banda | Rango |
|---|---|
| A | ≥ 90 |
| B | ≥ 80 |
| C | ≥ 70 |
| D | ≥ 60 |
| F | < 60 |

## Limitación por severidad (un fallo sev-5 topa en F)

Cualquier hallazgo del eje con `severity: 5` **y** `status: fail` (p. ej. un `noindex` en todo el sitio, un `robots.txt` que bloquea a todos los rastreadores, o canonical+noindex en páginas clave) limita esa puntuación a **40 (banda F)** independientemente del resto de aprobados, y establece `capped: true`. Esto evita que un sitio técnicamente roto se muestre en verde. El límite solo puede bajar una puntuación: si el valor ponderado ya es ≤ 40, no cambia nada.

## Interpretaciones del cuadrante Búsqueda-vs-IA

Cada puntuación lleva una `interpretation` de una línea. La implementación clasifica una puntuación como **alta** cuando `value ≥ 75` y como **baja** cuando `value < 60`; el cuadrante se lee a partir del par. Las cadenas exactas (Búsqueda, luego IA):

| Cuadrante | Interpretación de Búsqueda | Interpretación de IA |
|---|---|---|
| High Search / Low AI | Ranks well, hard to cite by AI engines. | Weak classic ranking despite content. |
| Low Search / High AI | Foundational SEO issues to fix first. | Citable by AI, but weak classic ranking. |
| Low Search / Low AI | Foundational issues — fix indexability and structure first. | Foundational issues — add structure, schema, and answer blocks. |
| High Search / High AI | Strong classic SEO; pursue depth and authority. | Strong AI visibility; keep content fresh and original. |
| Any other (mixed) | Mixed — see the prioritized actions. | Mixed — see the prioritized actions. |

> Nota: las puntuaciones entre 60 y 75 quedan fuera de ambos umbrales (alto y bajo), de modo que un par que no encaja claramente en un cuadrante produce la interpretación **mixta**.

## Forma de la salida

Al ejecutar el scorer se emiten ambas puntuaciones una junto a la otra:

```json
{
  "findings_count": 0,
  "search_seo": {
    "value": 0,
    "band": "F",
    "capped": false,
    "needs_api_count": 0,
    "categories": [ { "name": "...", "weight": 22, "value": 0, "active": false } ],
    "interpretation": "..."
  },
  "ai_visibility": { "value": 0, "band": "F", "capped": false, "needs_api_count": 0, "categories": [], "interpretation": "..." }
}
```

Ejecútalo con:

```bash
node scripts/score.mjs --findings findings.json
# or
cat findings.json | node scripts/score.mjs
```

La entrada es un array JSON de hallazgos, o `{ "findings": [...] }`, donde cada uno se ajusta a `schema/finding.schema.json`. El scorer es lógica pura y totalmente reproducible.
