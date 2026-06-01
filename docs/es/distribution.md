# Distribución

Cómo se distribuye `claude-seo-ai`, cómo instalarlo y cómo publicar
actualizaciones. El proyecto se distribuye a través de **dos canales** desde el
mismo repositorio: un **plugin de Claude Code** nativo y un paquete
**Vercel Skills** multiagente.

## Dos canales, un repositorio

| Canal | Mecanismo | Qué obtienes |
|---|---|---|
| **Plugin de Claude Code** | `.claude-plugin/marketplace.json` (`source: ./`) | Suite completa: skills + orquestación MCP/agente/hook |
| **Multiagente (Vercel Skills)** | `npx skills add` | Solo `skills/<name>/SKILL.md`, agnóstico del agente |

La capa de orquestación —los subagentes de `agents/` (4 auditores de solo
lectura + 1 escritor), el guardia de escritura PreToolUse de `hooks/` y los MCP
de renderizado opcionales de `.mcp.json.example`— es **específica de Claude
Code**. En otros agentes el proyecto **degrada a solo-skills**: los skills en
Markdown siguen ejecutándose, pero la seguridad a nivel de agente y la
aplicación de la lista de herramientas permitidas que ofrece Claude Code no
están presentes.

## Plugin de Claude Code

El `marketplace.json` incluido en el repositorio declara un único plugin con
origen en la raíz del repositorio (`"source": "./"`), de modo que el marketplace
**es** el repositorio: no hay un paso de publicación independiente ni subida a un
registro.

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

Publicado en `github.com/Hainrixz/claude-seo-ai` — `plugin.json` y
`marketplace.json` llevan ese `homepage` / `repository`. Si haces un fork de este
repo, actualiza el propietario en `plugin.json`, `marketplace.json` y los `$id` del esquema.

El plugin funciona completamente sin conexión en el **Tier 0** (WebFetch +
scripts de Node sin dependencias incluidos). El renderizado de JS y los Core Web
Vitals reales son opcionales en el Tier 1+ mediante un MCP de renderizado y/o
`PSI_API_KEY`; consulta [Niveles de datos](../../README.md#data-tiers).

## Multiagente vía Vercel Skills

Como cada skill es un simple archivo Markdown `skills/<name>/SKILL.md`, la suite
se instala en cualquier agente compatible (Cursor, Codex, Gemini CLI, Windsurf,
…):

```
npx skills add Hainrixz/claude-seo-ai
```

Qué se conserva y qué no:

| Capacidad | Plugin de Claude Code | Multiagente (solo-skills) |
|---|---|---|
| Skills de auditoría / corrección (`SKILL.md`) | Sí | Sí |
| Scripts de Node sin dependencias (Node ≥ 18) | Sí | Sí (si el agente puede ejecutar Node) |
| `seo-fixer-writer` como único subagente escritor | Sí | No (sin aislamiento de subagentes) |
| Hook de guardia de escritura PreToolUse | Sí | No |
| MCP de renderizado opcionales (`.mcp.json.example`) | Sí | Depende del agente anfitrión |
| `disable-model-invocation` en el corrector | Sí | No se aplica |

> Recordatorio de seguridad: en Claude Code el corrector
> ([`skills/fix`](../../skills/fix/SKILL.md)) tiene
> `disable-model-invocation: true` y solo `seo-fixer-writer` dispone de
> Write/Edit. Al ejecutar solo-skills en otro agente, esas garantías dependen
> del propio modelo y de los permisos del agente anfitrión, así que revisa los
> diffs antes de aceptar escrituras.

## Versionado

Las versiones residen en dos lugares y deben mantenerse alineadas:

- `.claude-plugin/plugin.json` → `"version"` (actualmente `0.1.0`)
- `.claude-plugin/marketplace.json` → el `"version"` de la entrada del plugin (también `0.1.0`)

Para publicar una actualización, **incrementa la `version` en `plugin.json`** (y
hazla coincidir en `marketplace.json`), haz commit y push. Los usuarios obtienen
la nueva build volviendo a ejecutar el flujo de marketplace/instalación o
`/reload-plugins`.

Sigue el versionado semántico:

| Incremento | Cuándo |
|---|---|
| Patch (`0.1.0 → 0.1.1`) | Correcciones, ediciones de documentación, sin cambios de comportamiento |
| Minor (`0.1.0 → 0.2.0`) | Nuevos skills, módulos o banderas; retrocompatible |
| Major (`0.1.0 → 1.0.0`) | Cambios incompatibles en comandos, esquema de hallazgos o puntuación |

Mantén los documentos bilingües (`docs/en` + `docs/es`) sincronizados cuando
cambie el comportamiento visible para el usuario, según
[`CONTRIBUTING.md`](../../CONTRIBUTING.md). Antes de publicar, valida el
manifiesto:

```
claude plugin validate .
```

## Lista de comprobación previa a la publicación

```
# syntax-check every script
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done
# run the script self-test against the fixtures
node tests/run.mjs
# validate the plugin manifest (if you have the CLI)
claude plugin validate .
```

## Licencia y originalidad

`claude-seo-ai` tiene **licencia MIT** (declarada tanto en `plugin.json` como en
`marketplace.json`; texto completo en [`LICENSE`](../../LICENSE)). Es una obra
original: inspirada en los patrones de herramientas de SEO de la comunidad, pero
sin copiar **ninguna** marca, texto ni nombre de otro proyecto. Las
contribuciones deben mantener el mismo estándar (consulta las reglas básicas en
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)), incluida la prohibición de
estadísticas, citas, fechas, credenciales o enlaces de identidad `sameAs`
inventados.

Al redistribuir, mantén intactos la `LICENSE` MIT y el aviso de copyright.
