# dsh-cooper-memory

Cross-session long-term memory **and** a local folder knowledge base for
[DeepSeek Harness](https://github.com/deepseek-ai).

Everything lives in a single local SQLite file — no Docker, no vector database service.
Apart from calls to the model gateway **you** configure, the process makes no outbound requests.

```bash
npm i -D dsh-cooper-memory
```

> Version pinned at `0.6.1`. Requires Node.js ≥ 22.5 (uses built-in `node:sqlite`).

---

## Why it exists

| Problem | What it does |
|---|---|
| Re-explaining context every new conversation | Distills preferences/facts and injects them **every turn** |
| The model doesn't know your project conventions | Ingests doc folders, injects matching snippets |
| Repeating the same explanation | Admission rules, de-duplication and merging keep the store clean |
| Can't remember where you left off | `memory_recall` / `kb_search` tools are always available |

---

## Architecture

```
DSH host process (Electron)
├─ index.js  native Cordis plugin
│    ├─ agent/pre-step ──► recall ──► inject <relevant-memories>
│    ├─ 30s timer ──────► auto-distill + queue maintenance + profile refresh
│    └─ embedded HTTP ──► 127.0.0.1:17890 (web UI)
└─ node mcp.mjs (child) ──► 20 MCP tools (stdio JSON-RPC)

Data: ~/.dsh-memory/
  mem.db                  SQLite (WAL), ~100 MB
  memories.journal.jsonl  append-only journal (source of truth, rebuildable)
  inject-trace.log        injection trace (for debugging)
```

**Three memory layers**

- **L1 items** — `preference / profile / fact / todo`, with states
  `pending → active`, plus `rejected` (suppression) and `superseded` (replaced)
- **L2 scene blocks** — clustered items compressed into one topic-level rule set,
  injected when the query matches
- **L3 user profile** — standing preferences compressed to ≤400 chars,
  injected **once per session** (signature-based, re-sent only when it changes)

**Knowledge base** — files are chunked by heading hierarchy plus length, retrieved
through four channels; each module also gets a one-line summary (see below).

---

## Installation

```bash
npm i -D dsh-cooper-memory
```

The plugin ships as a bundle; the profile patch loads it. Restart DSH to activate.

### Dependencies (all optional)

| Dependency | Purpose | If missing |
|---|---|---|
| `@node-rs/jieba` ^2.0.4 | **required** — Chinese segmentation (token index, query terms) | cannot run |
| `@xenova/transformers` ^2.17.2 | optional — local vector search (Transformers.js) | vector channel disabled, lexical only |
| `dsh-better-sidebar` | optional — sidebar card entry | native slot is used |
| `@deepseek-ai/dsh-llm` | optional — auto-distill / profile / rerank | rule-based extraction only |

Installing `@xenova/transformers` pulls in `onnxruntime-web` (inference), `onnxruntime-node` and `sharp`.
**At runtime only the WASM backend is used** (`env.backends.onnx.wasm.numThreads = 1`); the native
backend never participates. `sharp` is not used by this plugin at all — it comes from the
Transformers.js dependency chain (`overrides` pins it to 0.34).

The embedding model ships **inside the package** (`models/bge-small-zh-v1.5`, 23 MB)
and is never downloaded.

### UI entry points

Adapted automatically to your environment; any one of these is enough:

1. **Better Sidebar card** — start-page card titled "记忆" (when `dsh-better-sidebar` is installed)
2. **Native left panel** — via `sidebar.panellist` + `main` slots
3. **Browser** — `http://127.0.0.1:17890` (starts with the host)

---

## Automatic injection

Before every turn the plugin injects a `<relevant-memories>` block with four layers,
ordered by priority:

| Layer | Cap | Notes |
|---|---|---|
| L3 profile | 220 chars | once per session |
| L1 memories | `min(380, remaining×0.40)` | at most 6 items |
| Knowledge base | 300 chars | per block: path + module summary + 110-char excerpt |
| L2 scenes | ≤ `min(240, remaining)` | **whole block or nothing** — never cut mid-sentence |

Total budget is 1000 characters (configurable). The order — profile → memories →
knowledge → scenes — exists because memories (preferences/facts) are the core of the
plugin and must not be crowded out by documents.

### De-duplication

- Per session, only items **actually rendered into the text** are marked as injected;
  anything dropped by the budget can still appear on the next turn
- When the context is compacted (`contextFoldSeq` changes) the de-dup set is cleared,
  otherwise memories lost to compaction would never come back in that session

### When nothing is injected

- Fewer than 2 effective terms ("hi", "nice weather today") → no matching recall,
  only the standing layer
- The message is not a question ("delete v1-v4", "connect to the redis on 155") →
  **no knowledge base, no scenes** (the KB answers *how the system works*,
  not *please execute this*)
- Everything relevant was already injected in this session

### Debugging

```bash
tail -f ~/.dsh-memory/inject-trace.log
```

One line per step:

```
inject items=6 scenes=0 kb=2 chars=1003 session=... q="..."
skip no-messages / skip no-new-user kinds=goal / skip all-deduped / skip no-hits
autodistill ok added=3 / partial okTurns=15/16 / skip no-new-turns
```

---

## Retrieval

### Four channels

```
query
 ├─ ① jieba token BM25   chunks_fts_tokens MATCH    weight 1.0
 ├─ ② trigram substring  chunks_fts MATCH           weight 0.9
 ├─ ③ vectors (opt-in)   brute-force cosine         weight 0.6
 └─ ④ LIKE fallback      only if the others are empty   weight 0.35
        ↓
   weighted RRF (k=60) → normalise → min-max stretch → heuristic rerank → MMR (λ=0.7)
```

- **RRF normalisation** divides by the theoretical maximum ("first in every list"),
  not by a single list's maximum — normalising per list saturates all three channels at 1.0
- **min-max stretch** `0.35 + 0.65×norm`: raw RRF gaps are tiny; without stretching,
  MMR's redundancy penalty dominates relevance
- **Heuristic rerank runs before MMR**: index/summary pages down-weighted, spec docs
  up-weighted, title hits and exact identifiers boosted

### Vector search (optional)

- Model `bge-small-zh-v1.5` (quantized ONNX, 22.9 MB, shipped in the package), 512-dim
- Inference via `@xenova/transformers` ^2.17.2 (Transformers.js) on the **ONNX Runtime Web
  (WASM)** backend, `numThreads = 1`, **fully offline** (`env.allowRemoteModels = false`)
- Vectors live in the `chunk_vectors` table as int8 plus a per-row scale: 512 bytes per chunk,
  ~10 MB for 20k chunks. **No sqlite-vec, no external vector service** — search is an in-process
  brute-force cosine over an Int8Array matrix (~2 ms per query at 20k chunks)
- **BGE models require CLS pooling**; `mean` makes relevant documents score *below*
  irrelevant ones
- Queries need the prefix `为这个句子生成表示以用于检索相关文章：`
- First build takes 3–8 minutes; `vector-build` is incremental

Paraphrase recall (zero literal overlap):

| Query | Lexical only (zero literal overlap) | Hybrid |
|---|---|---|
| `how do I roll back a release` | versioning spec / branch strategy | **release process doc** / versioning spec |
| `who approves production deploys` | CI config / commit rules | **release process doc** / CI config |

On the injection path vectors only **fill gaps**: used when lexical recall is short,
and only above a 0.50 similarity floor (measured: relevant 0.52–0.61, irrelevant 0.43–0.47).

### Module index

One-line summaries per module, so the model can judge relevance before reading the body:

```bash
dsh-cooper-memory module-index-build    # batched, 8 modules per call
dsh-cooper-memory module-index-list
```

Grouping rules:

| Path shape | Module |
|---|---|
| `<root>/modules/<x>.md` | one file = one module |
| `<root>/<group>/<feature>/…` | one directory = one module |
| `<root>/<x>.md` | top-level single file |
| anything else | first two path segments |

Example:

```
Release process: pre-release checks, canary rollout and rollback steps.
```

### Reranking

- **Heuristic** (on by default, <10 ms): index/summary pages down-weighted, test reports
  down-weighted, spec docs up-weighted, title hits and exact identifiers boosted
- **LLM listwise rerank** (off by default, enable with `MEM_RERANK=1`): measured unstable
  on `deepseek-v4.1-flash` and 3–6 s slower — experimental only

---

## Memory lifecycle

```
conversation ──► distill (LLM) or rule extraction ──► candidate
                                                       ├─ too short / meta-noise / near-duplicate (≥0.78) → drop
                                                       ├─ passes admission → active
                                                       └─ otherwise → pending
pending ──► maintainPending (runs after every distill)
              ├─ duplicate of an active memory (≥0.75) → rejected
              └─ passes admission → active (tagged auto-admitted)
```

### Admission thresholds

| Condition | Threshold |
|---|---|
| Explicit directive phrasing (always / never / must / remember) | ≥0.72 |
| preference / profile / interest | ≥0.78 |
| fact | ≥0.82 |
| todo | ≥0.85 |
| Hedged wording (maybe / perhaps / seems) | always pending |
| Similar to an existing item, 0.5–0.78 (a proposed replacement) | always pending, human decides |

> These were lowered after measurement: the model rates facts at 0.85–0.9, so the
> original 0.92 threshold rejected essentially everything.

### When distillation runs

- Progressive threshold: 1 → 2 → 4 → 6 turns, plus a 300 s idle fallback, checked every 30 s
- **Scoped per session**: only the triggering session's own messages are processed,
  with a `meta.distill_wm:<sessionId>` watermark — parallel sessions neither mix
  content nor pay twice
- Exponential backoff on failure (30 s up to 10 min); on partial batch failure the
  watermark only advances to the last contiguous success

### Merging

```bash
dsh-cooper-memory merge-active --dry            # dry run
dsh-cooper-memory merge-active --threshold 0.6  # apply (writes a JSON backup)
dsh-cooper-memory restore-merge <backup-file>   # undo
```

Near-duplicates of the same kind are found by word containment; the longest, most
specific item survives, the others are marked `superseded` and point at it.

---

## MCP tools (20)

| Group | Tools |
|---|---|
| Memory | `memory_recall` `memory_remember` `memory_list` `memory_confirm` `memory_reject` `memory_edit` `memory_extract` `memory_distill` |
| Scenes / profile | `memory_scenes` `memory_scene` |
| Knowledge base | `kb_search` `kb_get` `kb_tree` `kb_ingest` |
| Ops | `memory_probe_llm` `memory_usage` |
| Extended | `kb_diff` `kb_history` `kb_edit` `kb_rollback` |

---

## CLI

```bash
dsh-cooper-memory <command>

# memory
stats | recall | remember | confirm-all | reject-all | admit-pending
dedupe-pending | merge-active | restore-merge | auto-admitted | revoke-auto
profile-build | profile-show | scenes-build | scenes-list | scenes-cluster
journal-rebuild | rebuild | usage | cleanup

# knowledge base
ingest <dir> [--prefix namespace] | search <query> | kb-clear | reindex-tokens
vector-status | vector-build | vector-on | vector-off
module-index-build | module-index-list
```

Use `--prefix` when ingesting several root folders so files with the same relative
path don't overwrite each other.

`cleanup` supports `--rule process|short|meta-config|all-imported`, always writes a
backup, and is reversible.

---

## Web UI

`http://127.0.0.1:17890`

- Directory tree on the left, search in the middle, chunk text on the right
- Chunk editing / version history / line diff / rollback
- Memory management (bulk-handle pending), scene and profile inspection
- Bound to `127.0.0.1` only; `Host` header validated (DNS-rebinding protection);
  request body capped at 2 MB

---

## Storage and cost

| Item | Measured |
|---|---|
| 20k-chunk knowledge base | `mem.db` ≈ 100 MB (10 MB of that is vectors) |
| One injection | ≈ 900–1000 chars ≈ 500 tokens |
| Vector index in memory | ≈ 47 MB; +115 MB once the model loads (MCP child only — the host loads neither) |
| Module index build | 125 modules / 18 calls / ≈ 31k tokens |
| Distillation | one call per 15 messages |

Accounting: `dsh-cooper-memory usage --days 7` aggregates tokens by purpose and date.

---

## Configuration

Configuration comes from the plugin row in the profile (`cordis.patch.yml`):

```yaml
budgetChars: 1000      # total injection budget (chars)
maxItems: 6            # max memory items per turn
maxScenes: 2           # max scene blocks
kb:
  enabled: true
  maxChunks: 2
  budgetChars: 300
l3:
  enabled: true
  maxChars: 220
autoDistill:
  enabled: true
  steadyThreshold: 6
  idleSeconds: 300
```

Environment variables:

| Variable | Purpose |
|---|---|
| `MEM_ROOT` | data directory (default `~/.dsh-memory`) |
| `MEM_DB` / `MEM_JOURNAL` | override the database / journal path |
| `MEM_RERANK=1` | enable LLM reranking |
| `MEM_KB_VECTOR_FLOOR` | vector similarity floor on the injection path (default 0.5) |
| `DEBUG_DISTILL=1` | print raw model output and errors |

---

## Typical workflow

```bash
# 1) distill existing conversations (optional)
dsh-cooper-memory distill --limit 30

# 2) ingest docs
dsh-cooper-memory ingest "D:\docs\Spec" --prefix spec
dsh-cooper-memory ingest "D:\docs\docs-site" --prefix docs

# 3) build vectors (optional, 3–8 min)
dsh-cooper-memory vector-build

# 4) build the module index (optional, ~31k tokens)
dsh-cooper-memory module-index-build

# 5) try it
dsh-cooper-memory search "release process" --limit 3
```

---

## Privacy

- Data stays in the local SQLite file; the only outbound calls go to **your** model gateway
- The embedding model ships with the package — nothing is downloaded
- Distillation sends your own message text (plugin injections and system notices stripped);
  disable `autoDistill` if you don't want it
- The web server binds to loopback only

---

## Known limitations

- No semantic segmentation: chunking is heading + fixed length, so long tables get cut
- Vectors are used for the knowledge base only; memory retrieval stays lexical (items are short)
- Single machine, single database — no multi-tenant, no sync
- LLM reranking depends on an external model; on gateway failure it silently falls back
- `cli search` is a **user-initiated** search and is **not** subject to the question-intent
  gate (searching for an ops command returns results — by design)

---

## Development

```bash
git clone <repo> && cd dsh-cooper-memory
npm i
node cli.mjs stats          # smoke test
node cli.mjs search "test" --limit 3
```

Design trade-offs and implementation details: [`docs/DETAIL.md`](docs/DETAIL.md).

---

## License

MIT