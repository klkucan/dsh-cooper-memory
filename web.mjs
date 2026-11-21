#!/usr/bin/env node
// web.mjs —— 本地 Web 界面（只绑 127.0.0.1，默认端口 17890，与 README 一致）
// 同一份 mem.db：左边目录树，中间检索，右边分块编辑 / 版本历史 / 比对 / 回滚 / 记忆管理
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { openDb } from './lib/db.mjs';
import {
  searchChunks, searchChunksHybrid, searchInteractive, getChunk, editChunk, chunkHistory, chunkVersionText,
  rollbackChunk, diffTexts, tree, remember, confirmMemory, rejectMemory,
  listMemories, recall,
} from './lib/core.mjs';
import { runAutoExtract, recentTurns, llmDistill } from './lib/extract.mjs';
import { probe as llmProbe } from './lib/llm.mjs';
import { recordUsage, setRecorder, usageSummary } from './lib/usage.mjs';

/**
 * 启动 Web 界面。既可作为脚本运行，也可被原生插件调用（这样页面跟着 DSH 一起活）。
 * @param {{port?:number, host?:string, quiet?:boolean}} opts
 * @returns {import('node:http').Server}
 */
export function startWeb(opts = {}) {
const PORT = Number(opts.port ?? process.env.MEM_WEB_PORT ?? 17890);
const HOST = opts.host ?? '127.0.0.1';
const QUIET = opts.quiet === true;
const db = openDb();
setRecorder((r) => recordUsage(db, r));

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
};

const MAX_BODY = 2 * 1024 * 1024;   // 2 MB：本地接口没有上传大文件的需求
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  let bytes = 0;                       // 按**字节**计量：中文一个字 3 字节，按字符算会放过三倍数据
  req.on('data', (c) => {
    bytes += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c);
    if (bytes > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
    b += c;
  });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>本地记忆 / 知识库</title>
<style>
 *{box-sizing:border-box} body{margin:0;font:14px/1.6 -apple-system,Segoe UI,sans-serif;background:#0f1115;color:#d6d9de}
 header{padding:10px 16px;border-bottom:1px solid #23262d;display:flex;gap:12px;align-items:center}
 header b{color:#8ab4f8} input,textarea,button,select{font:inherit;color:#d6d9de;background:#181b21;border:1px solid #2b2f38;border-radius:6px;padding:6px 8px}
 button{cursor:pointer} button:hover{background:#20242c}
 .wrap{display:grid;grid-template-columns:260px 320px 1fr;height:calc(100vh - 49px)}
 .col{overflow:auto;padding:12px;border-right:1px solid #23262d}
 .col:last-child{border-right:0}
 pre{margin:0;white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;color:#9aa4b2}
 .item{padding:6px 8px;border-radius:6px;cursor:pointer;border:1px solid transparent}
 .item:hover{background:#181b21;border-color:#2b2f38}
 .item.active{background:#1c2330;border-color:#3b4a63}
 .meta{color:#6b7686;font-size:12px}
 .chunk{white-space:pre-wrap;background:#14171d;border:1px solid #23262d;border-radius:8px;padding:10px;max-height:38vh;overflow:auto}
 textarea{width:100%;height:220px;resize:vertical}
 .row{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap;align-items:center}
 .diff{font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;background:#14171d;border-radius:8px;padding:10px}
 .add{color:#7ee787}.del{color:#ff7b72}
 .muted{color:#6b7686}
</style></head>
<body>
<header>
  <b>本地记忆 / 知识库</b>
  <input id="q" placeholder="检索…" style="width:280px">
  <button onclick="doSearch()">搜索</button>
  <span class="muted" id="stat"></span>
  <button onclick="loadMemories('pending')">待确认记忆</button>
  <button onclick="loadMemories('active')">全部记忆</button>
  <button onclick="runExtract()">规则提取</button>
  <button onclick="runDistill(this)">LLM 蒸馏</button>
</header>
<div class="wrap">
  <div class="col"><div class="meta">目录树</div><pre id="tree"></pre></div>
  <div class="col"><div class="meta">结果</div><div id="results"></div></div>
  <div class="col" id="detail"><div class="muted">选一个分块查看</div></div>
</div>
<script>
let cur=null;
const $=id=>document.getElementById(id);
async function api(p,o){const r=await fetch(p,o);return r.json()}
async function loadTree(){ $('tree').textContent=(await api('/api/tree')).tree || '(空)' }
async function doSearch(){
  const q=$('q').value.trim(); if(!q) return;
  const d=await api('/api/search?q='+encodeURIComponent(q));
  $('results').innerHTML=d.results.map(r=>
    \`<div class="item" onclick="openChunk(\${r.chunk_id})">
       <div>\${esc(r.path)} <span class="meta">#\${r.ordinal}</span></div>
       <div class="meta">score \${r.score}</div>
       <div class="meta">\${esc(r.text.slice(0,90))}…</div></div>\`).join('') || '<div class="muted">无结果</div>';
  $('stat').textContent=\`融合 \${d.fused} 条\`;
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function openChunk(id){
  cur=id;
  const c=await api('/api/chunk?id='+id);
  const h=await api('/api/history?id='+id);
  $('detail').innerHTML=\`
   <div class="meta">\${esc(c.rel_path)} · ordinal #\${c.ordinal} · 当前 v\${c.version} · tier \${c.tier}</div>
   <div class="chunk" id="curtext">\${esc(c.text)}</div>
   <div class="row"><textarea id="edit">\${esc(c.text)}</textarea></div>
   <div class="row">
     <button onclick="saveEdit()">保存为新版本</button>
     <span class="muted">基于 v\${c.version}</span>
   </div>
   <div class="meta">版本历史</div>
   <div>\${h.map(v=>\`<div class="item" onclick="showDiff(\${id},\${v.version})">v\${v.version} · \${v.editor} · \${v.created_at.slice(0,19)} · \${v.chars}字 · \${esc(v.note||'')}</div>\`).join('')}</div>
   <div class="row"><span class="muted">比对：</span><select id="fromV">\${h.map(v=>\`<option value="\${v.version}">v\${v.version}</option>\`).join('')}</select>
   <select id="toV"><option value="">当前</option>\${h.map(v=>\`<option value="\${v.version}">v\${v.version}</option>\`).join('')}</select>
   <button onclick="compare()">比对</button>
   <button onclick="doRollback()">回滚到所选版本</button></div>
   <div class="diff" id="diff"></div>\`;
}
async function saveEdit(){
  const t=$('edit').value;
  const r=await api('/api/chunk',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({id:cur,text:t,note:'web edit',base_version:null})});
  if(r.error){alert(r.error);return}
  openChunk(cur);
}
async function showDiff(id,to){
  // 与"当前版本"比：只传 from，服务端 to 为空时按当前正文比对（原来 from 和 to 传同一个版本号，diff 恒为全等行）
  const d=await api(\`/api/diff?id=\${id}&from=\${to}\`);
  $('diff').textContent=d.mode==='too-large'?'文本过大，跳过比对':JSON.stringify(d,null,1);
}
async function compare(){
  const f=$('fromV').value, t=$('toV').value;
  const d=await api(\`/api/diff?id=\${cur}&from=\${f}\${t?'&to='+t:''}\`);
  if(d.mode==='too-large'){$('diff').textContent=d.note;return}
  $('diff').innerHTML=d.hunks.map(h=>\`<div class="\${h.op==='+'?'add':h.op==='-'?'del':''}">\${h.op} \${esc(h.line)}</div>\`).join('');
}
async function doRollback(){
  const v=$('fromV').value;
  if(!confirm('回滚到 v'+v+'？会生成新版本。')) return;
  await api('/api/rollback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:cur,version:Number(v)})});
  openChunk(cur);
}
async function loadMemories(status){
  const d=await api('/api/memories?status='+status);
  $('detail').innerHTML='<div class="meta">记忆 · '+status+'</div>'+d.map(m=>
    \`<div class="item"><div><span class="meta">[\${esc(m.kind)}/\${esc(m.status)}]</span> \${esc(m.text)}</div>
     <div class="meta">\${m.confirmed_at?('确认于 '+m.confirmed_at.slice(0,19)):''} · 置信 \${m.confidence}\${m.supersedes_id?(' · <b style="color:#d29922">确认后将替代 #'+m.supersedes_id+'</b>'):''}\${m.superseded_by?(' · 已被 #'+m.superseded_by+' 替代'):''}</div>
     <div class="row">\${m.status==='pending'?\`<button onclick="cf(\${m.id})">确认</button><button onclick="rj(\${m.id})">拒绝</button>\`:''}</div></div>\`).join('');
}
async function cf(id){await api('/api/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});loadMemories('pending')}
async function rj(id){await api('/api/reject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,note:'web reject'})});loadMemories('pending')}
async function runExtract(){
  const r=await api('/api/extract',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  if(r.error){alert(r.error);return}
  alert('扫描 '+r.scannedFiles+' 个会话文件，新增 '+r.added.length+' 条待确认');
  loadMemories('pending');
}
async function runDistill(btn){
  const old=btn.textContent; btn.textContent='蒸馏中…'; btn.disabled=true;
  try{
    const r=await api('/api/distill',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    if(r.error){alert(r.error);return}
    alert('批次 '+r.batches+'，候选 '+r.candidates.length+'，新增 '+r.added.length);
    loadMemories('pending');
  }finally{ btn.textContent=old; btn.disabled=false; }
}
loadTree();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  // 只接受用回环地址访问：其它 Host 头一律拒绝，防止 DNS rebinding
  const hostHeader = String(req.headers.host || '');
  if (hostHeader && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHeader)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden host');
    return;
  }
  try {
    if (p === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    // 客户端信标：用来确认浏览器里的 Client 插件确实执行到了（排查入口不显示的必备证据）
    if (p === '/api/beacon') {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { ROOT } = await import('./lib/db.mjs');
        const file = path.join(ROOT, 'client-beacons.log');
        // 活日志：超过 64 KB 就保留最后 200 行，避免无限增长
        try {
          const st = fs.statSync(file);
          if (st.size > 64 * 1024) {
            const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200).join('\n') + '\n';
            fs.writeFileSync(file, keep, 'utf8');
          }
        } catch { /* 文件还不存在 */ }
        const line = `${new Date().toISOString()} stage=${url.searchParams.get('stage') || '?'} slot=${url.searchParams.get('slot') || '-'} ua=${String(req.headers['user-agent'] || '').slice(0, 60)}\n`;
        fs.appendFileSync(file, line, 'utf8');
      } catch { /* 信标失败不影响任何功能 */ }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/tree') return json(res, 200, { tree: tree(db) });
    if (p === '/api/search') {
      const r = await searchInteractive(db, { query: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit') || 10) });
      return json(res, 200, {
        fused: r.fused,
        results: r.results.map((x) => ({ chunk_id: x.id, path: x.rel_path, ordinal: x.ordinal, score: Number(x.score.toFixed(4)), text: x.text, module: x.module || null })),
      });
    }
    if (p === '/api/chunk' && req.method === 'GET') {
      const c = getChunk(db, Number(url.searchParams.get('id')));
      return c ? json(res, 200, c) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/chunk' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const r = editChunk(db, Number(b.id), String(b.text), { note: b.note || '', baseVersion: b.base_version ?? null });
        return json(res, 200, r);
      } catch (e) { return json(res, 409, { error: e.message }); }
    }
    if (p === '/api/history') return json(res, 200, chunkHistory(db, Number(url.searchParams.get('id'))));
    if (p === '/api/diff') {
      const id = Number(url.searchParams.get('id'));
      const from = Number(url.searchParams.get('from'));
      const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : null;
      const a = chunkVersionText(db, id, from);
      const b = to ? chunkVersionText(db, id, to) : getChunk(db, id);
      if (!a || !b) return json(res, 404, { error: 'variant not found' });
      return json(res, 200, diffTexts(a.text, b.text));
    }
    if (p === '/api/rollback' && req.method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, rollbackChunk(db, Number(b.id), Number(b.version))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/memories') return json(res, 200, listMemories(db, { status: url.searchParams.get('status'), limit: 200 }));
    if (p === '/api/recall') return json(res, 200, recall(db, url.searchParams.get('q') || ''));
    if (p === '/api/memory' && req.method === 'POST') {
      const b = await readBody(req);
      // status 白名单：前端对 status 未转义，任意字符串会变成存储型 XSS 载体
      const ALLOWED = ['pending', 'active', 'rejected'];
      const status = ALLOWED.includes(b.status) ? b.status : 'pending';
      return json(res, 200, remember(db, { ...b, status, source: b.source || 'web' }));
    }
    if (p === '/api/confirm' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, confirmMemory(db, Number(b.id))); }
    if (p === '/api/reject' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, rejectMemory(db, Number(b.id), { note: b.note || '' })); }
    if (p === '/api/distill' && req.method === 'POST') {
      // 读取失败（超限 / JSON 无效）时不能按默认参数继续启动任务
    let b;
    try { b = await readBody(req); } catch (e) {
      return json(res, 400, { error: 'invalid body: ' + (e?.message || e) });
    }
      const turns = recentTurns(b.sessions_dir || undefined, b.turns_limit ?? 60);
      const r = await llmDistill(db, { turns, limit: b.limit ?? 30, dryRun: !!b.dry_run });
      return json(res, 200, { batches: r.batches, candidates: r.candidates || [], added: r.added || [] });
    }
    if (p === '/api/probe-llm') {
      return json(res, 200, await llmProbe());
    }
    if (p === '/api/usage') {
      return json(res, 200, usageSummary(db, { days: Number(url.searchParams.get('days') || 30) }));
    }
    if (p === '/api/extract' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const r = runAutoExtract(db, {
        sessionsDir: b.sessions_dir || undefined,
        limit: b.limit ?? 30,
        dryRun: !!b.dry_run,
      });
      return json(res, 200, { scannedFiles: r.scannedFiles, newFiles: r.newFiles, candidates: r.candidates, added: r.added });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  if (QUIET) return;
  console.log(`memory web: http://${HOST}:${PORT}`);
  console.log(`db: ${process.env.MEM_DB || (process.env.MEM_ROOT || '~/.dsh-memory') + '/mem.db'}`);
});

return server;
}

// 直接 `node web.mjs` 运行时自动启动；被插件 import 时由调用方决定
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) startWeb();