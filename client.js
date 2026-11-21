// client.js —— 把记忆界面挂到宿主里
//
// 三条路，按优先级尝试，谁在就用谁：
//   1. Better Sidebar 的扩展点  ctx.betterSidebar.registerTab  （用户已有此插件）
//   2. DSH 原生槽位  main + sidebar.panellist                 （左侧栏面板）
//   3. 都不在 → 只留信标，不报错
//
// 每次 apply 都会往本地 Web 服务发一个信标，用来确认"客户端模块到底有没有被浏览器执行"。

window.__ModuleLoader__.load({
  id: 'dsh-cooper-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const KEY = 'cooper-memory';
    const UI_URL = 'http://127.0.0.1:17890/';

    const beacon = (stage, slot) => {
      try {
        const u = `${UI_URL}api/beacon?stage=${encodeURIComponent(stage)}&slot=${encodeURIComponent(slot || '-')}&t=${Date.now()}`;
        fetch(u, { mode: 'no-cors' }).catch(() => {});
      } catch { /* 信标失败无所谓 */ }
    };

    const openUI = () => { try { window.open(UI_URL, '_blank', 'noopener'); } catch { /* 被拦就算了 */ } };

    function Icon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('ellipse', { cx: 12, cy: 6, rx: 7, ry: 3 }),
        h('path', { d: 'M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6' }),
        h('path', { d: 'M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6' })
      );
    }

    function Panel() {
      try {
        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' } },
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '4px 10px', borderBottom: '1px solid rgba(128,128,128,.25)',
              fontSize: 11, opacity: 0.8, flex: '0 0 auto',
            },
          },
            h('span', null, '本地记忆'),
            h('a', {
              href: UI_URL, target: '_blank', rel: 'noreferrer',
              style: { marginLeft: 'auto', color: 'inherit', textDecoration: 'underline' },
            }, '新窗口打开')
          ),
          h('iframe', {
            title: '本地记忆', src: UI_URL,
            style: { flex: '1 1 auto', width: '100%', border: 0, display: 'block', background: '#fff' },
          })
        );
      } catch { return null; }
    }

    return {
      // 等 slots 服务就绪再激活：否则原生槽位注册会抛错（实测 stage=fail native:*）。
      // betterSidebar 不写进这里——它必须保持可选，装了才用。
      inject: ['slots'],
      apply(ctx) {
        beacon('apply');

        // ① Better Sidebar 扩展点
        try {
          const bs = ctx.get ? ctx.get('betterSidebar') : ctx.betterSidebar;
          if (bs && typeof bs.registerTab === 'function') {
            ctx.effect(() => bs.registerTab({
              id: 'dsh-cooper-memory:panel',
              title: '记忆',
              // 注意：DSH 0.1.5+ 只在开始页条目 ≤4 个时渲染描述，这里写了也可能不显示
              description: '待确认记忆 · 知识库检索 · 分块版本回滚',
              icon: (size) => h(Icon, { size: size || 16 }),
              order: 30,
              single: true,
              component: Panel,
            }));
            beacon('ok', 'betterSidebar');
          }
        } catch (e) { beacon('fail-betterSidebar'); }

        // ② DSH 原生槽位
        const reg = (slot, opts, Comp) => {
          try {
            if (!ctx.slots) { beacon('skip-no-slots', slot); return; }
            ctx.slots.inject(slot, () => ctx.slots.register(opts, Comp));
            beacon('ok', 'native:' + slot);
          } catch (e) { beacon('fail', 'native:' + slot); }
        };
        reg('main', { name: 'main', key: KEY }, Panel);
        reg('sidebar.panellist', { name: 'sidebar.panellist', id: KEY, order: 30, label: '记忆' }, Icon);
      },
    };
  },
});