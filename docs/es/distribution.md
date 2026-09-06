# Distribución

Cómo se distribuye `claude-seo-ai`, cómo instalarlo y cómo publicar actualizaciones. El proyecto se
distribuye a través de **dos canales** desde el mismo repositorio —un **plugin de Claude Code** nativo
y un paquete **Vercel Skills** multiagente— más una **GitHub Action** para CI.

## Dos canales, un repositorio

| Canal | Mecanismo | Qué obtienes |
|---|---|---|
| **Plugin de Claude Code** | `.claude-plugin/marketplace.json` (`source: ./`) | Todo: las skills, la capa de adquisición `scripts/`, los cinco subagentes, los dos hooks PreToolUse y los campos de credenciales de `userConfig` |
| **Multiagente (Vercel Skills)** | `npx skills add` | Solo los archivos `skills/<name>/SKILL.md`, agnósticos del agente |

La capa de orquestación —los subagentes de `agents/` (4 auditores de solo lectura + 1 escritor), los
guardias de escritura y de shell de `hooks/` y los MCP de renderizado opcionales de
`.mcp.json.example`— es **específica de Claude Code**.

## Plugin de Claude Code

El `marketplace.json` incluido en el repositorio declara un único plugin con origen en la raíz del
repositorio (`"source": "./"`), de modo que el marketplace **es** el repositorio: no hay un paso de
publicación independiente ni subida a un registro.

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

Publicado en `github.com/Hainrixz/claude-seo-ai` — `plugin.json` y `marketplace.json` llevan ese
`homepage` / `repository`. Si haces un fork del repositorio, actualiza el propietario en
`plugin.json`, `marketplace.json` y los `$id` de los esquemas para que apunten al tuyo.

El plugin funciona completamente sin conexión en el **Tier 0** (los scripts de Node sin dependencias
incluidos, sin claves). El renderizado de JS y los Core Web Vitals reales son opcionales en el
Tier 1+; consulta [`mcp.md`](mcp.md).

### Las credenciales se distribuyen como `userConfig`, no como archivos

`plugin.json` declara un bloque `userConfig` con las 17 claves de credenciales que entienden los
adaptadores de escritura —Shopify, WordPress, Webflow, Wix, Ghost, HubSpot, BigCommerce, más
`PSI_API_KEY`—, cada una marcada como `sensitive` cuando es un secreto. Claude Code las pide bajo
`/plugin` y exporta cada una como `CLAUDE_PLUGIN_OPTION_<KEY>`, que los adaptadores leen antes de
recurrir a la variable `<KEY>` a secas del entorno.

Nada de eso toca tu repositorio: no se escribe ningún `.env`, ningún valor llega a `argv` y el log de
correcciones redacta los comandos. Consulta [`platforms.md`](platforms.md#credenciales).

## Multiagente vía Vercel Skills

Como cada skill es un simple archivo Markdown `skills/<name>/SKILL.md`, la suite se instala en
cualquier agente compatible (Cursor, Codex, Gemini CLI, Windsurf, …):

```
npx skills add Hainrixz/claude-seo-ai
```

> **El canal solo-skills distribuye el Markdown, no la maquinaria.** `npx skills add` instala
> `skills/**`: **no** incluye `scripts/`, `agents/`, `hooks/`, `references/` ni `schema/`. Todas las
> skills de esta suite llaman a `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"` para adquirir y
> verificar, y `${CLAUDE_PLUGIN_ROOT}` es una variable de plugin de Claude Code. En una instalación
> solo-skills esos comandos no tienen nada que ejecutar, y el comportamiento documentado del
> orquestador es decirlo primero y recurrir al **modo solo-prompt**: resúmenes de `WebFetch`, todos
> los hallazgos que dependen de cabeceras, estados, renderizado o robots marcados como `needs_api`,
> sin persistencia y con el informe etiquetado como *«modo solo-prompt: no comparable con una
> ejecución con scripts»*.
>
> Si quieres la canalización determinista en otro agente, clona el repositorio y ejecuta los scripts
> directamente (`node scripts/audit.mjs <url> --out ./runs`): son ESM de Node ≥ 18 sin dependencias y
> sin paso de instalación.

Qué se conserva y qué no:

| Capacidad | Plugin de Claude Code | Multiagente (solo-skills) |
|---|---|---|
| Markdown de las skills (`SKILL.md`) | Sí | Sí |
| La capa de adquisición `scripts/` + ejecuciones persistidas | Sí | **No** — clona el repositorio para tenerlas |
| Registro de comprobaciones deterministas, `report.json`, `compare` | Sí | No (por el mismo motivo) |
| Adaptadores de plataforma y el flujo de corrección con tickets | Sí | No |
| `seo-fixer-writer` como único subagente escritor | Sí | No — sin aislamiento de subagentes |
| Hooks PreToolUse `guard-write` / `guard-bash` | Sí | No |
| Campos de credenciales de `userConfig` | Sí | No — usa variables de entorno |
| MCP de renderizado opcionales (`.mcp.json.example`) | Sí | Depende del agente anfitrión |
| `disable-model-invocation` en el corrector | Sí | No se aplica |

> Recordatorio de seguridad: en Claude Code el corrector
> ([`skills/fix`](../../skills/fix/SKILL.md)) tiene `disable-model-invocation: true` y solo
> `seo-fixer-writer` dispone de Write/Edit. Al ejecutar solo-skills en otro agente, esas garantías
> dependen del propio modelo y de los permisos del agente anfitrión: revisa cada diff antes de
> aceptarlo.

## GitHub Action (CI)

`action.yml`, en la raíz del repositorio, es una action compuesta que ejecuta el **subconjunto
determinista** (los módulos que juzga el modelo necesitan Claude Code, así que las dos puntuaciones en
CI describen lo que un script puede probar, no todo lo que cubre la auditoría completa). Configura
Node, ejecuta `scripts/audit.mjs`, escribe un resumen del job, expone las puntuaciones como salidas
del paso y sube el directorio de la ejecución como artefacto.

```yaml
- id: seo
  uses: Hainrixz/claude-seo-ai@v0.2.0
  with:
    url: https://example.com
    pages: '5'
    render: static            # the default never launches a browser
    fail-under-search: '70'
    fail-under-ai: '60'
```

Entradas: `url` (obligatoria), `pages`, `max`, `render`, `lang`, `environment`, `vertical`,
`fail-under-search`, `fail-under-ai`, `fail-on-gated`, `fail-on-severity`, `out`, `node-version`,
`upload-artifact`, `artifact-name`.
Salidas: `search-score`, `ai-score`, `search-band`, `ai-band`, `report-json`, `report-md`, `run-dir`,
`exit-code`.

Una compuerta activada termina con código **3** y emite una anotación `::error` por cada compuerta.
Hay un workflow listo para copiar en
[`.github/workflows/seo-audit-example.yml`](../../.github/workflows/seo-audit-example.yml); la matriz
de CI del propio proyecto (Node 18/20/22 × ubuntu/macos/windows) está en
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

Como CI fija la action por etiqueta, **etiqueta cada versión** (`v0.2.0`) para que `uses: …@v0.2.0`
resuelva.

## Versionado

La versión vive en **tres** lugares y deben moverse juntos:

- `.claude-plugin/plugin.json` → `"version"`
- `.claude-plugin/marketplace.json` → el `"version"` de la entrada del plugin
- `scripts/package.json` → `"version"`

`node scripts/check.mjs` verifica la alineación y falla si se desvían, así que esto se aplica en lugar
de recordarse.

Versionado semántico:

| Incremento | Cuándo |
|---|---|
| Patch (`0.2.0 → 0.2.1`) | Correcciones, ediciones de documentación, sin cambios de comportamiento |
| Minor (`0.2.0 → 0.3.0`) | Nuevas skills, comprobaciones, adaptadores o banderas; retrocompatible |
| Major (`0.2.0 → 1.0.0`) | Cambios incompatibles en los comandos, el esquema de hallazgos, el esquema del informe o la puntuación |

Para publicar una actualización: incrementa las tres versiones, actualiza `CHANGELOG.md`, mantén
`docs/en` y `docs/es` sincronizados, haz commit, etiqueta y push. Los usuarios obtienen la nueva build
volviendo a ejecutar el flujo de marketplace/instalación o `/reload-plugins`.

## Lista de comprobación previa a la publicación

```bash
# syntax-check every script, lint skill/agent frontmatter, verify the three versions align
node scripts/check.mjs

# the full suite (unit + e2e against the local fixture server; no network)
node tests/run.mjs        # or: node --test tests/

# validate the plugin manifest (if you have the CLI)
claude plugin validate . --strict
```

Después confirma a mano: que el encabezado `[Unreleased]` de `CHANGELOG.md` se convirtió en una
versión con fecha, que las tres versiones coinciden, que `docs/es/` refleja cualquier cambio de
`docs/en/` y que la etiqueta de la publicación coincide con la versión a la que apuntará la línea
`uses:` de la action.

## Licencia y originalidad

`claude-seo-ai` tiene **licencia MIT** (declarada tanto en `plugin.json` como en `marketplace.json`;
texto completo en [`LICENSE`](../../LICENSE)). Es una obra original: inspirada en los patrones de
herramientas de SEO de la comunidad, pero sin copiar **ninguna** marca, texto ni nombre de otro
proyecto. Las contribuciones deben mantener el mismo estándar —consulta
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)—, incluida la prohibición de estadísticas, citas, fechas,
credenciales o enlaces de identidad `sameAs` inventados.

Al redistribuir, mantén intactos la `LICENSE` MIT y el aviso de copyright.
