/* ============================================
   azi36.com 全站交互脚本
   滚动显现 · 卡片光斑 · 导航阴影 · 数字滚动
   ============================================ */

(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 0.0 存储小助手 ----------
     Safari 无痕、浏览器禁 cookie 时 localStorage 一读就抛异常。
     整个脚本在同一个 IIFE 里，任何一处抛错都会把后面所有交互带走，
     所以所有存取都从这里过一遍，失败就当没这功能。 */
  const store = {
    get(k, fallback = null) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 存不了就算了 */ } },
    getJSON(k, fallback) {
      try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch (e) { return fallback; }
    },
    setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 同上 */ } },
    session: {
      get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 同上 */ } },
    },
  };

  /* ---------- 0.1 深浅色：全站统一入口 ----------
     导航上的开关和首页灯泡彩蛋都调这里，免得两套逻辑各写一遍。
     head 里的内联脚本负责在首帧前把存下来的主题贴上去（防白闪）。 */
  const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' ? true : t === 'light' ? false : prefersDark();
  };
  const applyTheme = (mode) => {                 // mode: 'dark' | 'light'
    document.documentElement.setAttribute('data-theme', mode);
    store.set('azi-theme', mode);
    // 手动选过之后，两条按系统偏好分流的 theme-color 就不作数了，统一成当前色
    const c = mode === 'dark' ? '#17181b' : '#ffffff';
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', c));
    document.querySelectorAll('.theme-toggle').forEach(b => b.setAttribute('aria-pressed', String(mode === 'dark')));
  };
  window.aziToggleTheme = () => applyTheme(isDark() ? 'light' : 'dark');

  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.setAttribute('aria-pressed', String(isDark()));
    btn.addEventListener('click', () => window.aziToggleTheme());
  });

  /* ---------- 0. Twemoji：emoji 统一渲染成 SVG ----------
     CDN 加载失败时优雅降级为系统 emoji */
  const emojify = el => { if (window.twemoji) twemoji.parse(el, { folder: 'svg', ext: '.svg' }); };
  emojify(document.body);

  /* ---------- 1. 导航：滚动后加阴影 ---------- */
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- 2. 滚动显现动画 ----------
     自动作用于 main 的直接子元素和所有卡片，
     同一网格里的卡片会依次错开出现 */
  const targets = [];
  document.querySelectorAll('main > *').forEach(el => targets.push(el));
  // 注意：便利贴（.now-card）自带旋转 transform，不能进逐卡 reveal 名单
  document.querySelectorAll('.card-grid .card').forEach((el, i) => {
    el.style.setProperty('--d', (i % 6) * 70 + 'ms'); // 错开延迟
    targets.push(el);
  });

  if (reduceMotion) {
    targets.forEach(el => el.classList.add('visible'));
  } else {
    targets.forEach(el => el.classList.add('reveal'));
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(el => io.observe(el));
  }

  /* ---------- 3. 卡片鼠标光斑追踪 ----------
     mousemove 一秒能来上百次，每次都写 CSS 变量会逼浏览器反复重算样式；
     用 rAF 攒一帧只写一次，效果一样但不掉帧 */
  if (!reduceMotion) {
    let spotCard = null, spotX = 0, spotY = 0, spotQueued = false;
    const flushSpot = () => {
      spotQueued = false;
      if (!spotCard) return;
      spotCard.style.setProperty('--mx', spotX + 'px');
      spotCard.style.setProperty('--my', spotY + 'px');
    };
    document.querySelectorAll('.card, .feature').forEach(card => {
      card.addEventListener('mousemove', e => {
        const r = card.getBoundingClientRect();
        spotCard = card; spotX = e.clientX - r.left; spotY = e.clientY - r.top;
        if (!spotQueued) { spotQueued = true; requestAnimationFrame(flushSpot); }
      });
    });
  }

  /* ---------- 6. 打字机文案 ----------
     用法：<p data-typer='["句子一","句子二"]'><span class="typer-text"></span></p> */
  const typer = document.querySelector('[data-typer]');
  if (typer) {
    let lines = [];
    try { lines = JSON.parse(typer.dataset.typer); } catch (e) { /* 格式错误则跳过 */ }
    const textEl = typer.querySelector('.typer-text');
    if (textEl && lines.length) {
      if (reduceMotion) {
        textEl.textContent = lines[0]; // 关闭动效时静态显示第一句
      } else {
        let li = 0, ci = 0, deleting = false;
        const step = () => {
          const line = lines[li];
          if (!deleting) {
            textEl.textContent = line.slice(0, ++ci);
            if (ci === line.length) { deleting = true; setTimeout(step, 2400); return; }
            setTimeout(step, 95);
          } else {
            textEl.textContent = line.slice(0, --ci);
            if (ci === 0) { deleting = false; li = (li + 1) % lines.length; setTimeout(step, 450); return; }
            setTimeout(step, 40);
          }
        };
        setTimeout(step, 500);
      }
    }
  }

  /* ---------- 6.1 点击涟漪：在点击位置扩散一圈品牌色圆环 ---------- */
  if (!reduceMotion) {
    document.addEventListener('pointerdown', e => {
      const ring = document.createElement('span');
      ring.className = 'click-ring';
      ring.style.left = e.clientX + 'px';
      ring.style.top = e.clientY + 'px';
      document.body.appendChild(ring);
      ring.addEventListener('animationend', () => ring.remove());
    });
  }

  /* ---------- 6.2 社交图标彩蛋：点击冒气泡 ---------- */
  document.querySelectorAll('.footer-social a[data-say]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      let tip = a.querySelector('.say-tip');
      if (!tip) {
        tip = document.createElement('span');
        tip.className = 'say-tip';
        a.appendChild(tip);
      }
      tip.textContent = a.dataset.say;
      tip.classList.remove('show');
      void tip.offsetWidth; // 重启动画
      tip.classList.add('show');
    });
  });

  /* ---------- 6.4 文章目录：自动生成 + 滚动高亮 ----------
     页面上放 <nav class="toc-list"></nav>，自动收集 .article 里的 h2 */
  const tocList = document.querySelector('.toc-list');
  const article = document.querySelector('.article');
  if (tocList && article) {
    const heads = article.querySelectorAll('h2');
    heads.forEach((h, i) => {
      if (!h.id) h.id = 'sec-' + (i + 1);
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      tocList.appendChild(a);
    });
    const spy = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        tocList.querySelectorAll('a').forEach(x => x.classList.remove('on'));
        const link = tocList.querySelector('a[href="#' + e.target.id + '"]');
        if (link) link.classList.add('on');
      });
    }, { rootMargin: '-70px 0px -65% 0px' });
    heads.forEach(h => spy.observe(h));
  }

  /* ---------- 6.4b 日记目录：静态锚点 + 同款滚动高亮 ---------- */
  const diaryToc = document.querySelector('.diary-toc');
  if (diaryToc) {
    const entries = document.querySelectorAll('.diary-entry[id]');
    const dspy = new IntersectionObserver(es => {
      es.forEach(e => {
        if (!e.isIntersecting) return;
        diaryToc.querySelectorAll('a').forEach(x => x.classList.remove('on'));
        const link = diaryToc.querySelector('a[href="#' + e.target.id + '"]');
        if (link) link.classList.add('on');
      });
    }, { rootMargin: '-70px 0px -55% 0px' });
    entries.forEach(el => dspy.observe(el));
  }

  /* ---------- 6.5 推荐列表：分类筛选 + 折叠（统一状态机） ----------
     .rec-list 可选配前置 .filter-row 和 data-collapse="5"；
     · 只在「当前分类的匹配数」超过上限时才显示展开按钮
     · 按钮文案实时显示当前分类的条数
     · 切换分类自动重置为折叠态 */
  document.querySelectorAll('.rec-list').forEach(list => {
    const prev = list.previousElementSibling;
    const filterRow = prev && prev.classList.contains('filter-row') ? prev : null;
    const limit = parseInt(list.dataset.collapse, 10) || 0;
    const rows = [...list.querySelectorAll('.rec')];
    if (!filterRow && !limit) return;

    let tag = 'all';
    let folded = true;
    let btn = null;

    const match = r => tag === 'all' || (r.dataset.tags || '').split(/\s+/).includes(tag);

    const render = () => {
      const total = rows.filter(match).length;
      let shown = 0;
      rows.forEach(r => {
        let show = match(r);
        if (show && limit && folded && shown >= limit) show = false;
        if (show) shown++;
        r.classList.toggle('hidden', !show);
      });
      if (btn) {
        const need = total > limit; // 当前分类数量不足时按钮直接消失
        btn.style.display = need ? '' : 'none';
        if (need) btn.textContent = folded ? '展开全部 ' + total + ' 条 ▾' : '收起 ▴';
      }
    };

    if (limit && rows.length > limit) {
      btn = document.createElement('button');
      btn.className = 'rec-more';
      btn.addEventListener('click', () => { folded = !folded; render(); });
      list.appendChild(btn);
    }

    if (filterRow) {
      const chips = filterRow.querySelectorAll('.filter-chip');
      chips.forEach(chip => chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        tag = chip.dataset.tag;
        folded = true; // 换分类回到折叠初始态
        render();
      }));
    }

    render();
  });

  /* ---------- 6.7 首页「最近在忙」三件小玩具 ---------- */
  // ① 打磨进度：缓缓逼近 100% 但永远到不了
  const pct = document.getElementById('polishPct');
  if (pct && !reduceMotion) {
    let v = 87.3;
    setInterval(() => {
      v += (99.99 - v) * 0.012 + Math.random() * 0.015;
      if (v > 99.99) v = 99.99;
      pct.textContent = v.toFixed(2) + '%';
    }, 800);
  }

  // ② 长按灯泡充能灵感值；松手时 >100 就自动蹦迪，灵感一路回退到 0 才停
  const sparkCount = document.getElementById('sparkCount');
  const bulb = document.getElementById('bulbBtn');
  if (bulb && sparkCount) {
    const CAP = 999, TAP = 1;                      // 上限 999；单击就 +1
    const DT = 0.04, HOLD_MS = 220;               // 按住超过 220ms 才偷偷启动长按充能（不算单击）
    const G_BASE = 60, G_ACCEL = 120, G_MAX = 480; // 长按：隐藏的线性加速 60→480 /s
    const DRAIN = 260;                            // 蹦迪消散 /s（从 999 也就几秒归零）
    const TAP_GAP = 350;                          // 两次单击间隔 <350ms 算连点，不再切主题
    let spark = 0, charging = false, discoing = false, tapped = false;
    let tmr = null, holdTimer = null, chargeT = 0, confT = 0, lastTapT = -1e9;
    const render = () => { sparkCount.textContent = Math.floor(spark); };
    // 单击顺手拉个闸：开关灯（深/浅色）——「灯泡那边切深浅色」的彩蛋
    // 跟导航上那个正经开关走同一个入口（见 0.1），状态和图标都跟着一起变
    const flipLights = () => window.aziToggleTheme();
    const goDisco = () => {
      charging = false; discoing = true;
      document.body.classList.add('discoing');
      if (!tmr) tmr = setInterval(tick, 40);
    };
    function tick() {
      if (charging) {                             // 长按：线性加速充能，攒着不掉
        const held = (performance.now() - chargeT) / 1000;
        spark = Math.min(CAP, spark + Math.min(G_MAX, G_BASE + G_ACCEL * held) * DT);
        render();
        if (spark >= CAP) goDisco();              // 攒满 999 → 直接拉闸，归零
        return;
      }
      if (discoing) {                             // 蹦迪中：消散归零
        spark -= DRAIN * DT;
        if (window.aziConfetti && performance.now() - confT > 500) {
          confT = performance.now();
          window.aziConfetti(Math.random() * window.innerWidth, window.innerHeight * (.3 + Math.random() * .3));
        }
        if (spark <= 0) {
          spark = 0; render();
          discoing = false; document.body.classList.remove('discoing');
          clearInterval(tmr); tmr = null; return;
        }
        render(); return;
      }
      clearInterval(tmr); tmr = null;             // 100 以下歇着：不掉
    }
    const start = (e) => {
      if (discoing) return;                       // 蹦迪中不续充
      e.preventDefault();
      spark = Math.min(CAP, spark + TAP);         // 单击 = +1
      render();
      bulb.classList.add('lit');
      tapped = true;                              // 先当单击；按住超过 220ms 才转长按
      holdTimer = setTimeout(() => {
        tapped = false; charging = true; chargeT = performance.now();
        if (!tmr) tmr = setInterval(tick, 40);
      }, HOLD_MS);
    };
    const end = () => {
      clearTimeout(holdTimer);
      bulb.classList.remove('lit');
      if (tapped) {                                 // 纯单击
        tapped = false;
        const now = performance.now();
        if (now - lastTapT > TAP_GAP) flipLights();  // 间隔够长才切主题；连点只涨数值
        lastTapT = now;
      }
      if (charging) charging = false;               // 松开长按，攒着不掉
      if (spark > 100 && !discoing) goDisco();      // 攒过 100 → 蹦！
    };
    bulb.addEventListener('pointerdown', start);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }

  // ③ 借口生成器：点卡片轮换一句新借口
  const excuseText = document.getElementById('excuseText');
  const excuseCard = document.getElementById('excuseCard');
  if (excuseText && excuseCard) {
    const EXCUSES = [
      '真的在写了（刚新建了文件夹）。',
      '灵感马上就来，先眯十分钟。',
      '写了三行，删了五行，越写越少。',
      '别催了别催了，这就动笔 QAQ',
      '题目想好了，正文还在脑子里。（又绕回来了）',
    ];
    let ei = -1, trashed = false;
    const next = () => {
      if (trashed) return;
      ei = (ei + 1) % EXCUSES.length;
      excuseText.style.opacity = '0';
      setTimeout(() => {
        excuseText.textContent = EXCUSES[ei];
        excuseText.style.opacity = '1';
      }, 150);
    };
    excuseCard.addEventListener('click', next);
    excuseCard.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
    });
    // 废纸篓：hover 现身，点了把这条扔掉——删掉的需求才是真正完成的需求
    const excuseTrash = document.getElementById('excuseTrash');
    if (excuseTrash) {
      excuseTrash.addEventListener('click', e => {
        e.stopPropagation();          // 别触发借口轮换
        if (trashed) return;
        trashed = true;
        excuseCard.classList.add('trashed');
        excuseCard.removeAttribute('role'); excuseCard.removeAttribute('tabindex');
        const cb = document.getElementById('excuseCb'); if (cb) cb.textContent = '[x]';
        excuseText.style.opacity = '0';
        setTimeout(() => {
          excuseText.textContent = '这条已扔进废纸篓——删掉的需求，才是唯一真正完成的需求。';
          excuseText.style.opacity = '1';
        }, 150);
        const meta = document.getElementById('excuseMeta'); if (meta) meta.textContent = '已销毁';
        const undo = document.getElementById('excuseUndo');
        if (undo) undo.hidden = false;   // 垃圾桶隐去（CSS），亮出「撤回」
      });
    }
    // 撤回：点了没用，就是玩——飘一句嘴硬的话，永不真撤
    const excuseUndo = document.getElementById('excuseUndo');
    if (excuseUndo) {
      const NOPE = ['撤不回来了', '木已成舟', '泼出去的需求', '你以为呢', '想得美'];
      let ui = -1;
      excuseUndo.addEventListener('click', e => {
        e.stopPropagation();
        ui = (ui + 1) % NOPE.length;
        excuseUndo.textContent = NOPE[ui];
        excuseUndo.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 240 });
        setTimeout(() => { excuseUndo.textContent = '撤回'; }, 900);
      });
    }
  }

  /* ---------- 6.8 访客计数 ----------
     后端在自有服务器（经 api.azi36.com 暴露）；
     同一会话只计一次，API 不可达时静默隐藏 */
  const visitEl = document.getElementById('visitCount');
  if (visitEl) {
    const API = 'https://api.azi36.com';
    const path = store.session.get('azi-counted') ? '/count' : '/hit';
    fetch(API + path).then(r => r.json()).then(d => {
      if (typeof d.total !== 'number') return;
      store.session.set('azi-counted', '1');
      visitEl.textContent = ' · 第 ' + d.total.toLocaleString() + ' 次到访'
        + (typeof d.people === 'number' ? ' · 你是第 ' + d.people.toLocaleString() + ' 位路过的朋友' : '');
      visitEl.hidden = false;
    }).catch(() => { /* 后端未就绪时保持隐藏 */ });
  }

  /* ---------- 6.9 文章阅读统计 + 点赞 ----------
     每篇文章一个 slug（data-page）；阅读同一会话只计一次 */
  const pageStats = document.getElementById('pageStats');
  if (pageStats) {
    const API = 'https://api.azi36.com';
    const slug = pageStats.dataset.page;
    const likeBtn = document.getElementById('pageLike');

    const renderStats = (d) => {
      if (typeof d.reads !== 'number') return;
      document.getElementById('psReads').textContent =
        `读过 ${d.reads.toLocaleString()} 次 · ${d.readers.toLocaleString()} 人`;
      likeBtn.querySelector('i').textContent = d.likes;
      if (d.liked) likeBtn.classList.add('on');
      pageStats.hidden = false;
    };

    // 每次打开都记一次「读过」（人数按 IP 去重由服务端负责；刷子有每日限量兜底）
    fetch(`${API}/pages/${slug}/hit`, { method: 'POST' })
      .then(r => r.json()).then(renderStats).catch(() => {});

    likeBtn.addEventListener('click', () => {
      if (likeBtn.classList.contains('on')) return;
      likeBtn.classList.add('on');
      fetch(`${API}/pages/${slug}/like`, { method: 'POST' })
        .then(r => r.json()).then(d => {
          if (typeof d.likes === 'number') likeBtn.querySelector('i').textContent = d.likes;
        }).catch(() => {});
    });
  }

  /* ---------- 6.10 文章留言板 ----------
     留言与点赞走后端（PG 落库，按 data-page 归属文章）；点过赞的 id 记在本地防手滑 */
  const msgList = document.getElementById('msgList');
  if (msgList) {
    const API = 'https://api.azi36.com';
    const board = msgList.closest('.msg-board');
    const msgPage = (board && board.dataset.page) || 'home';
    // 后端返回的内容一律当不可信：& < > " ' 全转义，属性和文本位置都安全
    const escMsg = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const likedSet = new Set(store.getJSON('azi-liked', []));

    const msgRow = (m) => `
      <div class="msg">
        <div class="msg-head"><b>${escMsg(m.name)}</b><time>${escMsg(m.date || '')}</time></div>
        <p>${escMsg(m.text)}</p>
        <button class="msg-like${likedSet.has(String(m.id)) ? ' on' : ''}" data-like="${escMsg(m.id)}" aria-label="点赞">
          ♥ <i>${escMsg(m.likes || 0)}</i>
        </button>
      </div>`;

    const renderMsgs = (msgs) => {
      msgList.innerHTML = msgs.length
        ? msgs.map(msgRow).join('')
        : '<p class="msg-empty">留言本还空着——第一页留给你。</p>';
    };

    fetch(`${API}/msgs?page=${msgPage}`).then(r => r.json())
      .then(d => renderMsgs(d.msgs || []))
      .catch(() => { msgList.innerHTML = '<p class="msg-empty">留言本暂时打不开，回头再来。</p>'; });

    const sendBtn = document.getElementById('msgSend');
    const nameEl = document.getElementById('msgName');
    const msgTextEl = document.getElementById('msgText');
    if (sendBtn && msgTextEl) sendBtn.addEventListener('click', () => {
      const name = nameEl ? nameEl.value.trim() : '';
      const text = msgTextEl.value.trim();
      if (!text) { msgTextEl.focus(); return; }
      const btn = sendBtn;
      btn.disabled = true; btn.textContent = '寄出中…';
      fetch(API + '/msgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text, page: msgPage }),
      }).then(r => r.json()).then(d => {
        btn.disabled = false; btn.textContent = '留下';
        if (!d.ok) { btn.textContent = d.error || '没发出去'; setTimeout(() => { btn.textContent = '留下'; }, 2000); return; }
        msgTextEl.value = '';
        const empty = msgList.querySelector('.msg-empty');
        if (empty) empty.remove();
        msgList.insertAdjacentHTML('afterbegin', msgRow(d.msg));
      }).catch(() => { btn.disabled = false; btn.textContent = '网络开小差了'; setTimeout(() => { btn.textContent = '留下'; }, 2000); });
    });

    msgList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-like]');
      if (!btn) return;
      const id = btn.dataset.like;
      if (likedSet.has(id)) return;
      likedSet.add(id);
      store.setJSON('azi-liked', [...likedSet]);
      btn.classList.add('on');
      fetch(`${API}/msgs/${id}/like`, { method: 'POST' }).then(r => r.json()).then(d => {
        if (typeof d.likes === 'number') btn.querySelector('i').textContent = d.likes;
      }).catch(() => {});
    });
  }

  /* ---------- 7. 撒花特效（全站可用） ----------
     用法：window.aziConfetti(x, y) —— 在屏幕坐标处炸开一片 emoji。
     粒子放在 popover 宿主里：popover 与 dialog 同属顶层（top layer），
     每次爆炸前重新 show 一次即可压在最晚打开的弹窗之上 */
  window.aziConfetti = function (x, y) {
    if (reduceMotion) return;
    let layer = document.getElementById('aziConfettiLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'aziConfettiLayer';
      layer.setAttribute('popover', 'manual');
      layer.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;' +
        'background:none;border:0;margin:0;padding:0;pointer-events:none;overflow:hidden;';
      document.body.appendChild(layer);
    }
    try {
      if (layer.matches(':popover-open')) layer.hidePopover();
      layer.showPopover();
    } catch (e) { /* 老浏览器没有 Popover API：粒子仍会落在 body 层 */ }
    const host = layer.isConnected && layer.matches(':popover-open') ? layer : document.body;
    const EMO = ['🎉', '✨', '🎊', '⭐', '💙'];
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('span');
      s.textContent = EMO[i % EMO.length];
      s.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y +
        'px;font-size:' + (12 + Math.random() * 14) + 'px;pointer-events:none;z-index:9999;';
      host.appendChild(s);
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 140;
      s.animate([
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: 'translate(' + Math.cos(ang) * dist + 'px,' +
          (Math.sin(ang) * dist + 130) + 'px) rotate(' + (Math.random() * 360 - 180) + 'deg)', opacity: 0 }
      ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.8,.3,1)' })
        .onfinish = () => s.remove();
    }
  };

  /* ---------- 8. 可交互终端（首页） ----------
     点击终端即可输入命令，输入 help 查看全部 */
  const termBody = document.querySelector('.terminal-body');
  const termInput = document.querySelector('.term-input');
  if (termBody && termInput) {
    const inputLine = termInput.closest('.line');
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    /* 按实际渲染高度裁剪：长输出换行也不会撑爆窗口 */
    const trim = () => {
      while (termBody.scrollHeight > termBody.clientHeight) {
        const first = termBody.querySelector('.line');
        if (!first || first === inputLine) break;
        first.remove();
      }
    };
    const print = (html, cls) => {
      const d = document.createElement('div');
      d.className = 'line' + (cls ? ' ' + cls : '');
      d.innerHTML = html;
      emojify(d);
      termBody.insertBefore(d, inputLine);
      trim();
    };
    const CMDS = {
      'help': () => 'whoami · ls · cat 灵感.md · open 分享/推荐/游戏 · date · clear ……还有几条藏起来的，自己猜',
      'whoami': () => '今天最好看的访客',
      'ls': () => '分享/&nbsp;&nbsp;推荐/&nbsp;&nbsp;游戏/&nbsp;&nbsp;灵感.md',
      'cat 灵感.md': () => '「先把网站做完」…… ✓ 已完成',
      'date': () => new Date().toLocaleString('zh-CN'),
      'pwd': () => '/home/azi36/摸鱼中',
      'uname': () => 'AziOS 1.0（矮子内核 · 从不蓝屏）',
      'git status': () => 'On branch main · nothing to commit，摸鱼 tree clean',
      'rm -rf 拖延症': () => '删除失败：资源正被 azi36 进程占用',
      'ping': () => 'pong!（延迟：看心情）',
      'exit': () => '退出失败：你已经是网站的一部分了',
      'hi': () => '你好呀，欢迎光临 👋',
      '你好': () => '你好呀，欢迎光临 👋',
      'clear': () => {
        [...termBody.querySelectorAll('.line')].forEach(l => { if (l !== inputLine) l.remove(); });
        return null;
      },
      'open 分享': () => { setTimeout(() => location.href = 'shares/', 400); return '正在打开分享…'; },
      'open 推荐': () => { setTimeout(() => location.href = 'links/', 400); return '正在打开推荐…'; },
      'open 游戏': () => { setTimeout(() => location.href = 'games/', 400); return '正在打开游戏…'; },
      'fable': () => { setTimeout(() => location.href = 'fable/', 600); return '找 C某F 是吧？带你去看它的打工日记…'; },
      'sudo fable': () => '权限不足：它只听甲方的（甲方也不太听得动）',
    };
    let interacted = false; // 访客碰过终端后，停止循环播放开机剧本
    document.querySelector('.terminal').addEventListener('click', () => {
      interacted = true;
      termInput.focus();
    });
    termInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const cmd = termInput.value.trim();
      termInput.value = '';
      if (!cmd) return;
      print('<span class="prompt">$</span>' + esc(cmd));
      if (/^sudo\s+rm/.test(cmd)) { print('😱 想什么呢', 'out'); return; }
      const fn = CMDS[cmd];
      if (fn) { const r = fn(); if (r) print(r, 'out'); }
      else print('command not found: ' + esc(cmd) + '（试试 help）', 'out');
    });

    /* 开机小剧本：逐字打出命令，中途报一次错再重试成功 */
    if (!reduceMotion) {
      [...termBody.querySelectorAll('.line')].forEach(l => { if (l !== inputLine) l.remove(); });
      inputLine.style.display = 'none';

      const typeCmd = cmd => new Promise(done => {
        const d = document.createElement('div');
        d.className = 'line';
        d.innerHTML = '<span class="prompt">$</span><span></span><span class="term-caret"></span>';
        termBody.insertBefore(d, inputLine);
        trim();
        const slot = d.children[1];
        let i = 0;
        const t = setInterval(() => {
          slot.textContent = cmd.slice(0, ++i);
          if (i >= cmd.length) {
            clearInterval(t);
            const c = d.querySelector('.term-caret');
            if (c) c.remove();
            trim();
            setTimeout(done, 320);
          }
        }, 58);
      });

      const BOOT = [
        { cmd: 'whoami', out: 'Azi36', cls: 'out' },
        { cmd: 'npm run 灵感', out: 'Error: 灵感余额不足', cls: 'out err' },
        { cmd: 'npm run 灵感 --force', out: '✓ 强行执行成功，网站已上线', cls: 'out ok' },
        { cmd: 'status', out: '● 在线 · 慢慢更新中', cls: 'out' },
      ];

      const wait = ms => new Promise(r => setTimeout(r, ms));

      const playBoot = async () => {
        [...termBody.querySelectorAll('.line')].forEach(l => { if (l !== inputLine) l.remove(); });
        inputLine.style.display = 'none';
        for (const step of BOOT) {
          await typeCmd(step.cmd);
          print(esc(step.out), step.cls);
          await wait(480);
        }
        inputLine.style.display = ''; // 剧本演完，把输入行交还给访客
        trim();
      };

      (async () => {
        await wait(700);
        await playBoot();
        // 没人动终端就隔一会儿再演一遍；访客一碰就永久谢幕
        while (!interacted) {
          await wait(9000);
          if (interacted) break;
          await playBoot();
        }
      })();
    }
  }
})();

/* ---------- 7. header 彩蛋：换脸徽标 + 头像大爆炸 ---------- */
(function () {
  var emojify = function (el) { if (window.twemoji) twemoji.parse(el, { folder: 'svg', ext: '.svg' }); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 状态徽标：表情轮播，Keep Smile——淡出淡入换脸，节奏放慢，不抢戏
  var emo = document.querySelector('.nav-emo');
  if (emo) {
    var FACES = ['😊', '😆', '🤪', '😎', '🥱', '🤯', '🥳', '😤', '🫠', '😇', '🤠', '😪'];
    var fi = 0;
    emo.style.transition = 'opacity .4s ease';
    setInterval(function () {
      emo.style.opacity = '0';
      setTimeout(function () {
        fi = (fi + 1) % FACES.length;
        emo.textContent = FACES[fi];
        emojify(emo);
        emo.style.opacity = '1';
      }, 420);
    }, 8000);
  }

  // 站长头像：轻点=就地放烟花（不跳转）；拖拽=弹弓，松手满屏飞、撞墙反弹、最后飞回窝里收尾
  var gh = document.querySelector('.nav-gh');
  if (gh && gh.querySelector('img')) {
    var BITS = ['💥', '✨', '⭐', '🎉', '😂', '🤯', '👻', '🃏', '💫', '🍀', '🎵'];

    // 从一点炸出 n 个碎片
    function burst(cx, cy, n) {
      if (reduceMotion) return;
      for (var i = 0; i < n; i++) {
        var s = document.createElement('span');
        s.className = 'gh-frag';
        s.textContent = BITS[Math.floor(Math.random() * BITS.length)];
        s.style.left = cx + 'px';
        s.style.top = cy + 'px';
        document.body.appendChild(s);
        emojify(s);
        var a = Math.random() * Math.PI * 2;
        var d = 55 + Math.random() * 90;
        var dx = Math.cos(a) * d, dy = Math.sin(a) * d - 30;
        var rot = (Math.random() * 2 - 1) * 260;
        s.animate([
          { transform: 'translate(-50%,-50%) scale(.6) rotate(0deg)', opacity: 1 },
          { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(1.25) rotate(' + rot + 'deg)', opacity: 0 }
        ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.16,.8,.35,1)' }).onfinish = function () { this.effect.target.remove(); };
      }
    }
    function boom(cx, cy, n) {
      if (!flying) { gh.classList.remove('boom'); void gh.offsetWidth; gh.classList.add('boom'); }
      burst(cx, cy, n);
    }
    // 飘一句嘴硬的话
    var SAYS = ['哎哟', '别戳了', '痒', '嗯？', '干嘛', '轻点', '再戳打你', '有完没完'];
    function sayEgg(cx, cy) {
      if (reduceMotion) return;
      var s = document.createElement('span');
      s.className = 'gh-frag'; s.style.fontSize = '13px'; s.style.fontWeight = '700';
      s.textContent = SAYS[Math.floor(Math.random() * SAYS.length)];
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      document.body.appendChild(s);
      s.animate([
        { transform: 'translate(-50%,-50%) scale(.7)', opacity: 1 },
        { transform: 'translate(-50%,-140%) scale(1)', opacity: 0 }
      ], { duration: 900, easing: 'cubic-bezier(.16,.8,.35,1)' }).onfinish = function () { s.remove(); };
    }

    var down = null, dragging = false, flying = false, samples = [];
    var clickN = 0, lastClick = 0, flyer = null, home = null;

    // 造克隆体来飞，本体留原地 visibility:hidden 占位——布局不塌，Keep Smile 不会顶上来
    function liftOff() {
      home = gh.getBoundingClientRect();
      flyer = gh.cloneNode(true);
      flyer.classList.add('gh-flyer');
      flyer.style.cssText = 'position:fixed;margin:0;pointer-events:none;left:' + home.left +
        'px;top:' + home.top + 'px;width:' + home.width + 'px;height:' + home.height + 'px;z-index:9999';
      document.body.appendChild(flyer);
      gh.style.visibility = 'hidden';
      flying = true;
    }
    function land() {
      if (flyer) { flyer.remove(); flyer = null; }
      gh.style.visibility = '';
      flying = false;
    }

    // 轻点：随机小彩蛋；短时间连点攒怒气，戳满 5 下就炸开、自己满屏乱弹
    function clickEgg() {
      if (flying) return;
      var r = gh.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var now = performance.now();
      clickN = (now - lastClick < 900) ? clickN + 1 : 1;
      lastClick = now;
      if (clickN >= 5) {
        clickN = 0;
        boom(cx, cy, 26); sayEgg(cx, cy);
        if (!reduceMotion) { liftOff(); var ang = Math.random() * 6.28; fling(home.left, home.top, Math.cos(ang) * 26, Math.sin(ang) * 26); }
        return;
      }
      boom(cx, cy, 8 + Math.floor(Math.random() * 8));
      if (Math.random() < 0.4) sayEgg(cx, cy);
    }

    gh.addEventListener('click', function (e) { e.preventDefault(); });  // 一律不跳转

    gh.addEventListener('pointerdown', function (e) {
      if (flying) return;
      e.preventDefault();
      down = { x: e.clientX, y: e.clientY };
      dragging = false;
      samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      try { gh.setPointerCapture(e.pointerId); } catch (_) {}
    });

    gh.addEventListener('pointermove', function (e) {
      if (!down) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!dragging && moved > 6 && !reduceMotion) { liftOff(); dragging = true; }
      if (dragging && flyer) {
        flyer.style.left = (e.clientX - home.width / 2) + 'px';
        flyer.style.top = (e.clientY - home.height / 2) + 'px';
        samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
        if (samples.length > 5) samples.shift();
      }
    });

    gh.addEventListener('pointerup', function (e) {
      if (!down) return;
      try { gh.releasePointerCapture(e.pointerId); } catch (_) {}
      var wasDrag = dragging;
      down = null; dragging = false;
      if (!wasDrag) { clickEgg(); return; }
      var vx = 0, vy = 0;
      if (samples.length >= 2) {
        var a = samples[0], b = samples[samples.length - 1], dt = Math.max(16, b.t - a.t);
        vx = (b.x - a.x) / dt * 16; vy = (b.y - a.y) / dt * 16;
      }
      fling(parseFloat(flyer.style.left), parseFloat(flyer.style.top), vx, vy);
    });

    function fling(x, y, vx, vy) {
      if (!flyer) return;
      var W = window.innerWidth, H = window.innerHeight, sz = home.width, m = 4;
      var start = performance.now(), last = start, bounces = 0, angle = 0;
      if (Math.hypot(vx, vy) < 6) { var a0 = Math.random() * 6.28; vx = Math.cos(a0) * 15; vy = Math.sin(a0) * 15; }
      function step(now) {
        var dt = Math.min(2.2, (now - last) / 16.67); last = now;
        x += vx * dt; y += vy * dt;
        vx *= 0.997; vy *= 0.997;                 // 摩擦更小，弹得久（治「弹一半就停」）
        var hit = false, sq = 1;
        if (x < m) { x = m; vx = -vx * 0.82; bounces++; hit = true; } else if (x > W - sz - m) { x = W - sz - m; vx = -vx * 0.82; bounces++; hit = true; }
        if (y < m) { y = m; vy = -vy * 0.82; bounces++; hit = true; } else if (y > H - sz - m) { y = H - sz - m; vy = -vy * 0.82; bounces++; hit = true; }
        if (hit) { burst(x + sz / 2, y + sz / 2, 6); sq = 0.78; }   // 撞墙：爆炸 + 挤压
        angle += vx * 0.7;                        // 边飞边转，「乱飞」才有动感
        flyer.style.left = x + 'px'; flyer.style.top = y + 'px';
        flyer.style.transform = 'rotate(' + angle + 'deg) scale(' + sq + ')';
        if (Math.hypot(vx, vy) > 0.3 && (now - start) < 7000 && bounces < 40) requestAnimationFrame(step);
        else returnHome(x, y, angle);
      }
      requestAnimationFrame(step);
    }

    function returnHome(x, y, angle) {
      if (!flyer) { land(); return; }
      var hx = home.left, hy = home.top;
      var anim = flyer.animate(
        [{ left: x + 'px', top: y + 'px', transform: 'rotate(' + angle + 'deg)' },
         { left: hx + 'px', top: hy + 'px', transform: 'rotate(360deg)' }],
        { duration: 680, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
      );
      anim.onfinish = function () {
        flyer.style.left = hx + 'px'; flyer.style.top = hy + 'px'; flyer.style.transform = '';
        flyer.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(.85)' }, { transform: 'scale(1)' }],
          { duration: 460, easing: 'cubic-bezier(0.22, 1.14, 0.36, 1)' }
        );
        burst(hx + home.width / 2, hy + home.height / 2, 8);   // 落窝收尾烟花
        setTimeout(land, 280);
      };
    }
  }

  // ---------- 星级拆成单颗，好让 hover 时一颗颗填充长大（真日期跳过） ----------
  document.querySelectorAll('.rec-score, .card-meta .date').forEach(function (el) {
    var txt = el.textContent;
    if (!/[★☆]/.test(txt)) return;
    var html = '';
    for (var i = 0; i < txt.length; i++) {
      if (txt[i] === '★') html += '<i class="on">★</i>';
      else if (txt[i] === '☆') html += '<i class="off">☆</i>';
    }
    el.innerHTML = html;
  });

  // ---------- 站标文字：hover 逐字打出 Azi36，再干净换成「矮子哎呦喂~」 ----------
  var logoLink = document.querySelector('.site-logo');
  var wm = logoLink && logoLink.querySelector('.wordmark');
  var logoMark = logoLink && logoLink.querySelector('.logo-mark');
  if (wm && logoMark && !reduceMotion) {
    var wmOrig = wm.innerHTML, wmTimers = [], wmBusy = false;
    var wmClear = function () { wmTimers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); wmTimers = []; };
    // 打字时保留原配色：字母走文字色、数字包 <b> 走品牌色（还原「Azi 黑 + 36 变色」）
    var typeHtml = function (n) {
      var full = 'Azi36', s = '';
      for (var k = 0; k < n; k++) s += /[0-9]/.test(full[k]) ? '<b>' + full[k] + '</b>' : full[k];
      return s;
    };
    // 蹦迪时连头像和「Keep Smile」一起癫
    var ghEl = document.querySelector('.nav-gh');
    var navStat = document.querySelector('.nav-status');
    var navTextNode = navStat && navStat.lastChild;
    var navOrig = navTextNode ? navTextNode.nodeValue : '';
    var goCrazy = function () {
      if (ghEl) ghEl.classList.add('gh-crazy');
      if (navTextNode) navTextNode.nodeValue = ' 别 Keep 了，蹦！';
    };
    var calmDown = function () {
      if (ghEl) ghEl.classList.remove('gh-crazy');
      if (navTextNode) navTextNode.nodeValue = navOrig;
    };
    var wmRestore = function () { wmClear(); wm.classList.remove('wm-disco'); wm.style.opacity = '1'; wm.innerHTML = wmOrig; calmDown(); wmBusy = false; };
    wm.style.transition = 'opacity .22s var(--ease)';
    // 只挂在「图标」上——hover 文字不触发，也就不会把文字冲没
    logoMark.addEventListener('mouseenter', function () {
      if (wmBusy) return; wmBusy = true; wmClear();
      wm.classList.remove('wm-disco'); wm.style.opacity = '1';
      var i = 0; wm.innerHTML = '';
      var t1 = setInterval(function () {
        i++; wm.innerHTML = typeHtml(i);
        if (i >= 5) {
          clearInterval(t1);
          var t2 = setTimeout(function () {
            wm.style.opacity = '0';
            var t3 = setTimeout(function () { wm.textContent = '矮子哎呦喂~'; wm.classList.add('wm-disco'); wm.style.opacity = '1'; goCrazy(); }, 220);
            wmTimers.push(t3);
          }, 520);
          wmTimers.push(t2);
        }
      }, 135);
      wmTimers.push(t1);
    });
    logoMark.addEventListener('mouseleave', wmRestore);
  }

  // ---------- 主页 hero：读作「矮子」点了碰瓷「哎呦喂~」 ----------
  var badge = document.querySelector('.name-badge');
  if (badge) {
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', function () {
      badge.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-4deg) scale(1.06)' }, { transform: 'rotate(4deg)' }, { transform: 'rotate(0)' }], { duration: 340 });
      if (reduceMotion) return;
      var r = badge.getBoundingClientRect();
      var s = document.createElement('span');
      s.className = 'gh-frag'; s.style.fontSize = '15px'; s.style.fontWeight = '800'; s.textContent = '哎呦喂~';
      s.style.left = (r.left + r.width / 2) + 'px'; s.style.top = r.top + 'px';
      document.body.appendChild(s);
      s.animate([{ transform: 'translate(-50%,-50%) scale(.6) rotate(-8deg)', opacity: 1 }, { transform: 'translate(-50%,-170%) scale(1.1) rotate(6deg)', opacity: 0 }], { duration: 950, easing: 'cubic-bezier(.16,.8,.35,1)' }).onfinish = function () { s.remove(); };
    });
  }

  // ---------- 主页 kicker：欢迎一下自己 → 鼓掌炸开 + 全屏表情雨 + 遮罩欢迎语 ----------
  var welc = document.querySelector('.welcome-egg');
  if (welc) {
    var CLAP = ['👏', '🎉', '🥳', '🎊', '💐', '🙌', '✨', '🤩', '😄', '🍾', '🎈'];
    var welcBanner = function () {
      var b = document.createElement('div'); b.className = 'welc-banner';
      b.textContent = '欢迎光临～您里边请！';
      document.body.appendChild(b);
      b.animate([{ transform: 'translate(-50%,-50%) scale(.7)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1.05)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }], { duration: 600, easing: 'cubic-bezier(0.22,1.14,0.36,1)', fill: 'forwards' });
      setTimeout(function () { b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, fill: 'forwards' }).onfinish = function () { b.remove(); }; }, 2200);
    };
    welc.addEventListener('click', function () {
      welcBanner();
      if (reduceMotion) return;
      var r = welc.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      for (var i = 0; i < 16; i++) {
        var s = document.createElement('span'); s.className = 'gh-frag'; s.style.fontSize = (16 + Math.random() * 14) + 'px';
        s.textContent = CLAP[Math.floor(Math.random() * CLAP.length)];
        s.style.left = cx + 'px'; s.style.top = cy + 'px'; document.body.appendChild(s); emojify(s);
        var a = Math.random() * 6.28, d = 60 + Math.random() * 120;
        s.animate([{ transform: 'translate(-50%,-50%) scale(.5)', opacity: 1 }, { transform: 'translate(calc(-50% + ' + Math.cos(a) * d + 'px),calc(-50% + ' + Math.sin(a) * d + 'px)) scale(1.2)', opacity: 0 }], { duration: 800, easing: 'cubic-bezier(.16,.8,.35,1)' }).onfinish = function () { this.effect.target.remove(); };
      }
      var W = window.innerWidth, Hh = window.innerHeight;
      for (var j = 0; j < 42; j++) {
        (function (j) {
          setTimeout(function () {
            var e = document.createElement('span'); e.className = 'welc-rain';
            e.textContent = CLAP[Math.floor(Math.random() * CLAP.length)];
            e.style.left = (Math.random() * W) + 'px'; e.style.fontSize = (18 + Math.random() * 30) + 'px';
            document.body.appendChild(e); emojify(e);
            e.animate([{ transform: 'translateY(-50px) rotate(0)', opacity: 1 }, { transform: 'translateY(' + (Hh + 70) + 'px) rotate(' + ((Math.random() * 2 - 1) * 400) + 'deg)', opacity: 1 }], { duration: 2200 + Math.random() * 1800, easing: 'linear' }).onfinish = function () { e.remove(); };
          }, j * 45);
        })(j);
      }
    });
  }
})();
