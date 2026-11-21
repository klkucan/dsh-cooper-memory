// lib/chunk.mjs —— 三层分块器
//
// 移植自 WeKnora 的 chunker 设计（见 03-features/04-chunking.md）：
//   Tier1 heading  → Tier2 heuristic → Tier3 legacy(递归兜底)
//   每层都要过 Validator（5 条拒绝规则），不合格降级到下一层
//   overlap 取"语义后缀"（段落 > 换行 > 句末），不做定长硬切
//
// 简化：不解析 PDF/DOCX，只吃 markdown / 纯文本。

const SEPARATORS = ['\n\n', '\n', '。'];
const ABS_MAX = 7500;

const RE_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const RE_NUMBERED = /^\s*(?:\d+(?:\.\d+){0,3}[.、)]|[IVX]{1,5}\.)\s+\S/;
const RE_CHAPTER = /^\s*(?:第[一二三四五六七八九十百千0-9]+[章节篇部]|Chapter\s+\d+|Kapitel\s+\d+)/i;
const RE_ALLCAPS = /^\s*[A-Z][A-Z0-9 \-\u2013:]{6,60}\s*$/;
const RE_SEPARATOR = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;

/** 文档画像：单遍扫描，决定用哪条 Tier 链 */
export function profile(text) {
  let headings = 0;
  let numbered = 0;
  let chapters = 0;
  let allcaps = 0;
  let formfeeds = 0;
  const levels = new Map();
  for (const line of text.split('\n')) {
    const m = RE_HEADING.exec(line);
    if (m) {
      headings++;
      const lv = m[1].length;
      levels.set(lv, (levels.get(lv) || 0) + 1);
    }
    if (RE_NUMBERED.test(line)) numbered++;
    if (RE_CHAPTER.test(line)) chapters++;
    if (RE_ALLCAPS.test(line)) allcaps++;
  }
  formfeeds = (text.match(/\f/g) || []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const lang = cjk > latin ? 'zh' : latin > 0 ? 'en' : 'mixed';
  const lines = text.split('\n').length || 1;
  return {
    chars: text.length,
    lines,
    headings,
    headingDensity: headings / lines,
    levels: [...levels.entries()],
    numbered,
    chapters,
    allcaps,
    formfeeds,
    lang,
  };
}

/** 选主分割层级：出现 ≥3 次的最浅层级，否则最深 */
function dominantLevel(p) {
  const stable = p.levels.filter(([, n]) => n >= 3).sort((a, b) => a[0] - b[0]);
  if (stable.length) return stable[0][0];
  const any = p.levels.sort((a, b) => b[0] - a[0]);
  return any.length ? any[0][0] : 0;
}

function selectChain(p) {
  const chain = [];
  if (p.headings >= 3 && p.headingDensity > 0.005 && dominantLevel(p) > 0) chain.push('heading');
  if (p.numbered >= 5 || p.chapters > 0 || p.formfeeds > 0 || p.allcaps >= 5) chain.push('heuristic');
  chain.push('legacy');
  return chain;
}

// ---------- 受保护区间：代码块 / 公式不切开 ----------
function atomicize(text) {
  const out = [];
  const re = /(```[\s\S]*?```|\$\$[\s\S]*?\$\$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ atomic: false, text: text.slice(last, m.index) });
    out.push({ atomic: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ atomic: false, text: text.slice(last) });
  return out.length ? out : [{ atomic: false, text }];
}

/** 递归按分隔符切分，返回片段数组 */
function splitRecursive(text, size, seps = SEPARATORS) {
  if (text.length <= size) return [text];
  for (let i = 0; i < seps.length; i++) {
    const sep = seps[i];
    if (!text.includes(sep)) continue;
    const parts = text.split(sep).map((s, idx, arr) => (idx < arr.length - 1 ? s + sep : s)).filter(Boolean);
    const res = [];
    for (const part of parts) {
      if (part.length <= size) res.push(part);
      else res.push(...splitRecursive(part, size, seps.slice(i + 1)));
    }
    return res;
  }
  // 无分隔符可用：按字符硬切（兜底）
  const res = [];
  for (let i = 0; i < text.length; i += size) res.push(text.slice(i, i + size));
  return res;
}

/** 超长单元先按语义边界细化，保证不产出超过 budget 的块 */
function refine(unit, budget) {
  if (unit.length <= budget) return [unit];
  const pieces = splitRecursive(unit, budget);
  const out = [];
  for (const p of pieces) {
    if (p.length <= budget) out.push(p);
    else {
      // 仍超长：按换行/空格/字符硬切
      for (let i = 0; i < p.length; i += budget) out.push(p.slice(i, i + budget));
    }
  }
  return out;
}

/** 把片段装成块 */
function pack(units, size) {
  const flat = [];
  for (const u of units) {
    if (u.length > size) flat.push(...refine(u, size));
    else flat.push(u);
  }
  const chunks = [];
  let cur = '';
  for (const u of flat) {
    if (cur && cur.length + u.length > size) { chunks.push(cur); cur = ''; }
    cur += u;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

// ---------- Tier 1：标题分块 ----------
function tierHeading(text, size) {
  const p = profile(text);
  const primary = dominantLevel(p);
  if (!primary) return null;
  const lines = text.split('\n');
  const stack = [];
  const sections = [];
  let cur = { crumb: '', body: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && RE_HEADING.exec(line);
    if (m && m[1].length <= primary) {
      if (cur.body.length) sections.push(cur);
      const lv = m[1].length;
      while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop();
      stack.push({ lv, title: m[2] });
      const crumb = stack.map((s) => '#'.repeat(s.lv) + ' ' + s.title).join('\n');
      cur = { crumb, body: [line] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.length) sections.push(cur);
  if (sections.length < 2) return null;
  const chunks = [];
  for (const s of sections) {
    const body = s.body.join('\n').trim();
    if (!body) continue;
    if (body.length + s.crumb.length + 2 <= size) chunks.push({ text: body, crumb: s.crumb });
    else for (const piece of splitRecursive(body, size)) chunks.push({ text: piece, crumb: s.crumb });
  }
  return chunks;
}

// ---------- Tier 2：启发式边界 ----------
function tierHeuristic(text, size) {
  const lines = text.split('\n');
  const marks = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    let prio = 0;
    if (line.includes('\f')) prio = 100;
    else if (RE_NUMBERED.test(line)) prio = 90;
    else if (RE_CHAPTER.test(line)) prio = 85;
    else if (RE_ALLCAPS.test(line)) prio = 70;
    else if (RE_SEPARATOR.test(line)) prio = 60;
    if (prio) marks.push({ line: i, prio });
  }
  if (marks.length < 3) return null;
  marks.sort((a, b) => a.line - b.line || b.prio - a.prio);
  const cuts = [0, ...marks.map((m) => m.line).filter((n) => n > 0), lines.length];
  const uniq = [...new Set(cuts)].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    const body = lines.slice(uniq[i], uniq[i + 1]).join('\n').trim();
    if (!body) continue;
    if (body.length <= size) chunks.push({ text: body, crumb: '' });
    else for (const piece of splitRecursive(body, size)) chunks.push({ text: piece, crumb: '' });
  }
  return chunks.length >= 2 ? chunks : null;
}

// ---------- Tier 3：递归兜底 ----------
function tierLegacy(text, size) {
  const units = [];
  for (const seg of atomicize(text)) {
    if (seg.atomic) units.push(seg.text);
    else units.push(...splitRecursive(seg.text, size));
  }
  return pack(units, size).map((t) => ({ text: t, crumb: '' }));
}

// ---------- Validator：5 条拒绝规则 ----------
export function validate(chunks, size) {
  const sizes = chunks.map((c) => c.text.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!chunks.length) return 'no chunks produced';
  if (total > size * 2 && chunks.length === 1) return 'single chunk for large document';
  const tiny = sizes.filter((s, i) => s < 50 && i < sizes.length - 1).length;
  if (tiny > 2 && tiny > chunks.length / 4) return 'too many tiny chunks';
  const max = Math.max(...sizes);
  if (max < size / 4) return 'all chunks far below target size';
  if (max > size * 2) return 'chunk exceeds 2x target size';
  return null;
}

/** 语义重叠：从上一块尾部取一段，吸附到最近的语义边界 */
export function applyOverlap(chunks, overlap) {
  if (!overlap || chunks.length < 2) return chunks;
  const out = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].text;
    const winStart = Math.max(0, prev.length - overlap - 4);
    const win = prev.slice(winStart);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '？', '！', '. ']) {
      const idx = win.lastIndexOf(sep);
      if (idx >= 0) { cut = winStart + idx + sep.length; break; }
    }
    const tail = cut >= 0 ? prev.slice(cut) : '';
    out.push({ ...chunks[i], text: tail + chunks[i].text });
  }
  return out;
}

/**
 * 主入口
 * @returns {{chunks: Array<{ordinal,text,heading,context_header,tier}>, tier, rejected}}
 */
export function splitDoc(text, cfg = {}) {
  const size = cfg.chunk_size || 512;
  const overlap = Math.min(cfg.chunk_overlap ?? 80, Math.floor(size / 2));
  const forced = cfg.strategy && cfg.strategy !== 'auto' ? cfg.strategy : null;
  const p = profile(text);
  const chain = forced ? [forced, 'legacy'] : selectChain(p);
  const rejected = [];
  for (const tier of chain) {
    let raw = null;
    if (tier === 'heading') raw = tierHeading(text, size);
    else if (tier === 'heuristic') raw = tierHeuristic(text, size);
    else raw = tierLegacy(text, size);
    if (!raw) { rejected.push({ tier, reason: 'tier produced nothing' }); continue; }
    const reason = validate(raw, size);
    // 兜底层永不返回空（对齐 WeKnora：legacy 即使未通过校验也采纳）
    const isLast = tier === 'legacy' || tier === chain[chain.length - 1];
    if (reason && !isLast) { rejected.push({ tier, reason }); continue; }
    if (reason && isLast) rejected.push({ tier, reason: reason + '（兜底层强制采纳）' });
    const withOverlap = applyOverlap(raw, overlap);
    const chunks = withOverlap.map((c, i) => ({
      ordinal: i,
      text: c.text.trim(),
      heading: (c.crumb.split('\n').pop() || '').replace(/^#+\s*/, ''),
      context_header: c.crumb || '',
      tier,
    })).filter((c) => c.text);
    return { chunks, tier, rejected, profile: p };
  }
  return { chunks: [], tier: 'none', rejected, profile: p };
}