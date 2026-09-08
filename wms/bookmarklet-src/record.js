/* 동작 녹화 — 즐겨찾기(북마클릿)용.
   내가 화면에서 무엇을 클릭하고 무엇을 입력했는지 순서대로 적어 둔다.
   화면을 바꾸지 않는다. 듣기만 한다.

   페이지가 새로 뜨면 스크립트는 사라지지만 기록은 sessionStorage 에 남는다.
   그럴 때 즐겨찾기를 한 번 더 누르면 앞의 기록에 이어서 계속 적는다. */
(function () {
  'use strict';

  var KEY = '__wmsRec';
  var MAXLEN = 60;

  function c(s) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > MAXLEN ? s.slice(0, MAXLEN) + '…' : s; }

  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY)) || { on: false, t0: Date.now(), items: [] }; }
    catch (e) { return { on: false, t0: Date.now(), items: [] }; }
  }
  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(rec)); } catch (e) {}
  }
  var rec = load();

  /* ---------- 요소를 사람이 알아볼 수 있게 적는다 ---------- */
  function labelOf(e) {
    try {
      if (e.id) {
        var l = e.ownerDocument.querySelector('label[for="' + CSS.escape(e.id) + '"]');
        if (l) return c(l.textContent);
      }
      var r = e.closest('tr'), t = e.closest('td,th');
      if (r && t) {
        var a = [].slice.call(r.children), i = a.indexOf(t);
        for (var k = i - 1; k >= 0; k--) { var x = c(a[k].textContent); if (x) return x; }
      }
      var p = e.previousElementSibling;
      while (p) { var y = c(p.textContent); if (y) return y; p = p.previousElementSibling; }
      if (e.parentElement && e.parentElement.previousElementSibling) return c(e.parentElement.previousElementSibling.textContent);
    } catch (_) {}
    return '';
  }

  function desc(e) {
    if (!e || !e.tagName) return '(없음)';
    var tag = e.tagName.toLowerCase();
    var s = tag;
    if (e.type && tag === 'input') s += '/' + e.type;
    if (e.id) s += ' #' + e.id;
    if (e.name) s += ' [name=' + e.name + ']';
    if (!e.id && !e.name) {
      var cls = (typeof e.className === 'string' && e.className.trim()) ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (cls) s += ' .' + cls;
    }
    var txt = c(tag === 'input' ? (e.value || '') : e.textContent) || c(e.title) || c(e.getAttribute && e.getAttribute('alt'));
    if (txt && tag !== 'input') s += ' "' + txt + '"';
    // 라벨은 입력 계열에만 찾는다. 버튼은 제 글자가 이미 이름 노릇을 하는데,
    // 거기에 옆 칸 글자까지 끌어다 붙이면 오히려 알아보기 어려워진다.
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var lab = labelOf(e);
      if (lab) s += ' (' + lab + ')';
    }
    return s;
  }

  /* 표 안이면 몇 번째 줄인지 — 그리드 조작을 나중에 재현하려면 필요하다 */
  function rowInfo(e) {
    try {
      var tr = e.closest('tr');
      if (!tr || !tr.parentElement) return '';
      var rows = [].slice.call(tr.parentElement.children);
      if (rows.length < 2) return '';   // 한 줄짜리 배치용 표는 그리드가 아니다
      return ' <' + (rows.indexOf(tr) + 1) + '/' + rows.length + '번째 줄>';
    } catch (_) { return ''; }
  }

  function push(kind, frame, e, value) {
    if (!rec.on) return;
    var item = { ms: Date.now() - rec.t0, kind: kind, frame: frame, el: desc(e) + rowInfo(e), val: value == null ? null : String(value) };
    var last = rec.items[rec.items.length - 1];
    // 같은 곳에서 같은 일이 순식간에 두 번 잡히면(라벨+입력 등) 한 번만 남긴다
    if (last && last.kind === kind && last.el === item.el && last.val === item.val && item.ms - last.ms < 250) return;
    rec.items.push(item);
    save();
    render();
  }

  /* ---------- 프레임마다 귀를 붙인다 ---------- */
  var attached = [];
  function attach(w, path) {
    var d;
    try { d = w.document; } catch (_) { return; }
    if (!d || attached.indexOf(d) >= 0) return;
    attached.push(d);

    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('#__wmsRecBox')) return;   // 내 상자는 기록하지 않는다
      var v = null;
      if (t && t.type === 'checkbox') v = t.checked ? '체크됨' : '해제됨';
      if (t && t.type === 'radio') v = '선택됨';
      push('클릭', path, t, v);
    }, true);

    d.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('#__wmsRecBox')) return;
      var v = t.type === 'checkbox' ? (t.checked ? '체크됨' : '해제됨') : t.value;
      push('값변경', path, t, v);
    }, true);

    d.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('#__wmsRecBox')) return;
      var k = ev.key;
      // 글자 한 자 한 자는 시끄럽다. 엔터·펑션키·탭 같은 것만 남긴다.
      var keep = (k === 'Enter' || k === 'Tab' || k === 'Escape' || /^F\d+$/.test(k) || ev.ctrlKey || ev.altKey);
      if (!keep) return;
      var name = (ev.ctrlKey ? 'Ctrl+' : '') + (ev.altKey ? 'Alt+' : '') + (ev.shiftKey && k.length > 1 ? 'Shift+' : '') + k;
      push('키 ' + name, path, t, t && 'value' in t ? t.value : null);
    }, true);

    d.addEventListener('submit', function (ev) { push('전송', path, ev.target, null); }, true);

    // 나중에 생기는 iframe 도 잡는다
    try {
      new w.MutationObserver(function () { scan(); }).observe(d.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  function scan() {
    (function walk(w, path, depth) {
      if (depth > 4) return;
      attach(w, path);
      var fr;
      try { fr = w.frames; } catch (_) { return; }
      for (var i = 0; i < fr.length; i++) {
        var nm = '';
        try { nm = (fr[i].frameElement && (fr[i].frameElement.id || fr[i].frameElement.name)) || ''; } catch (_) {}
        walk(fr[i], path + '>' + i + (nm ? ':' + nm : ''), depth + 1);
      }
    })(window, 'top', 0);
  }

  /* ---------- 상자 ---------- */
  var box, listEl, btnRec, btnCopy, cbMask, cntEl, statEl;

  function fmt(it) {
    var s = Math.floor(it.ms / 1000);
    var stamp = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    var val = it.val;
    if (val != null && cbMask && cbMask.checked && it.val !== '체크됨' && it.val !== '해제됨' && it.val !== '선택됨') {
      val = val ? '●'.repeat(Math.min(val.length, 8)) : '';
    }
    return '[' + stamp + '] ' + it.frame + '  ' + it.kind + '  ' + it.el + (val != null ? '  = "' + val + '"' : '');
  }
  function text() {
    return '화면: ' + location.href + '\n녹화 ' + rec.items.length + '건\n\n' + rec.items.map(fmt).join('\n');
  }
  function render() {
    if (!listEl) return;
    cntEl.textContent = rec.items.length + '건';
    if (statEl) paintRec();
    listEl.textContent = rec.items.slice(-200).map(fmt).join('\n');
    listEl.scrollTop = listEl.scrollHeight;
  }

  function ui() {
    var old = document.getElementById('__wmsRecBox');
    if (old) old.remove();
    box = document.createElement('div');
    box.id = '__wmsRecBox';
    box.setAttribute('style', 'position:fixed;z-index:2147483647;right:12px;bottom:12px;width:520px;height:360px;background:#fff;' +
      'border:2px solid #c33;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;' +
      'font-family:"Malgun Gothic",sans-serif;font-size:12px;color:#222');

    var bar = document.createElement('div');
    bar.setAttribute('style', 'padding:6px 10px;background:#c33;color:#fff;font-weight:bold;display:flex;gap:6px;' +
      'align-items:center;flex-wrap:wrap;cursor:move');
    var ttl = document.createElement('span');
    ttl.textContent = '동작 녹화';
    cntEl = document.createElement('span');
    cntEl.setAttribute('style', 'font-weight:normal;opacity:.9');
    var sp = document.createElement('div');
    sp.setAttribute('style', 'flex:1');

    btnRec = document.createElement('button');
    btnRec.setAttribute('style', 'padding:3px 12px;cursor:pointer');
    btnCopy = document.createElement('button');
    btnCopy.textContent = '복사';
    btnCopy.setAttribute('style', 'padding:3px 12px;cursor:pointer');
    var btnClr = document.createElement('button');
    btnClr.textContent = '지우기';
    btnClr.setAttribute('style', 'padding:3px 10px;cursor:pointer');
    var btnX = document.createElement('button');
    btnX.textContent = '닫기';
    btnX.setAttribute('style', 'padding:3px 10px;cursor:pointer');

    var foot = document.createElement('label');
    foot.setAttribute('style', 'padding:5px 10px;border-top:1px solid #eee;display:flex;gap:6px;align-items:center;color:#666');
    cbMask = document.createElement('input');
    cbMask.type = 'checkbox';
    foot.appendChild(cbMask);
    foot.appendChild(document.createTextNode('값 가리기 (도서명·번호를 ●●● 로 바꿔서 복사)'));
    cbMask.onchange = render;

    statEl = document.createElement('div');
    statEl.setAttribute('style', 'padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold');

    listEl = document.createElement('div');
    listEl.setAttribute('style', 'flex:1;padding:8px;overflow:auto;white-space:pre;font-family:Consolas,monospace;font-size:11px;line-height:1.6');

    bar.appendChild(ttl); bar.appendChild(cntEl); bar.appendChild(sp);
    bar.appendChild(btnRec); bar.appendChild(btnCopy); bar.appendChild(btnClr); bar.appendChild(btnX);
    box.appendChild(bar); box.appendChild(statEl); box.appendChild(listEl); box.appendChild(foot);
    document.body.appendChild(box);

    // 상자가 작업할 자리를 가리면 곤란하니 끌어서 옮길 수 있게 한다
    var drag = null;
    bar.addEventListener('mousedown', function (e) {
      if (e.target !== bar && e.target !== ttl && e.target !== sp) return;
      var r = box.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      box.style.left = (e.clientX - drag.x) + 'px';
      box.style.top = (e.clientY - drag.y) + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () { drag = null; });

    btnRec.onclick = function () {
      rec.on = !rec.on;
      if (rec.on && !rec.items.length) rec.t0 = Date.now();
      save();
      paintRec();
    };
    btnCopy.onclick = function () {
      var ta = document.createElement('textarea');
      ta.value = text();
      ta.setAttribute('style', 'position:fixed;left:-9999px');
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      btnCopy.textContent = ok ? '복사됨' : '실패';
      setTimeout(function () { btnCopy.textContent = '복사'; }, 2000);
    };
    btnClr.onclick = function () {
      if (!confirm('기록을 지울까요?')) return;
      rec.items = [];
      rec.t0 = Date.now();
      save();
      render();
    };
    btnX.onclick = function () { box.remove(); };
    paintRec();
    render();
  }

  function paintRec() {
    // 한 버튼이 시작과 정지를 겸한다. 지금 무슨 상태인지 글자로 분명히 적고,
    // 아래 상태줄에도 같은 말을 써 둔다 — 버튼만 봐서는 헷갈린다는 이야기를 들었다.
    btnRec.textContent = rec.on ? '■ 녹화 정지' : '● 녹화 시작';
    btnRec.style.fontWeight = 'bold';
    box.style.borderColor = rec.on ? '#c33' : '#888';
    box.querySelector('div').style.background = rec.on ? '#c33' : '#888';
    statEl.textContent = rec.on
      ? '● 녹화 중 — 평소대로 작업하세요. 끝나면 [■ 녹화 정지] → [복사]'
      : (rec.items.length ? '정지됨 — [복사] 를 누르세요. 이어서 녹화하려면 [● 녹화 시작]'
                          : '[● 녹화 시작] 을 누르고 평소대로 반품 작업을 하세요');
    statEl.style.color = rec.on ? '#c33' : '#555';
    statEl.style.background = rec.on ? '#fff4f4' : '#fafafa';
  }

  /* 채번처럼 서버가 값을 채워 넣는 자리는 change 가 안 뜬다.
     사람이 손대지 않았는데 값이 달라진 칸을 훑어서 따로 남긴다 —
     "채번을 누르면 여기에 이 번호가 찍힌다" 를 알아야 자동화를 짤 수 있다. */
  var snap = {};
  function watchValues() {
    if (!rec.on) return;
    (function walk(w, path, depth) {
      if (depth > 4) return;
      var d;
      try { d = w.document; } catch (_) { return; }
      if (!d) return;
      try {
        d.querySelectorAll('input,select,textarea').forEach(function (e) {
          if (e.type === 'hidden' || e.type === 'password') return;
          if (e.closest('#__wmsRecBox')) return;
          var key = path + '|' + (e.id || e.name || desc(e));
          var v = e.type === 'checkbox' || e.type === 'radio' ? String(e.checked) : e.value;
          if (!(key in snap)) { snap[key] = v; return; }
          if (snap[key] === v) return;
          snap[key] = v;
          if (d.activeElement === e) return;      // 지금 타이핑 중인 칸은 건너뛴다
          push('화면변화', path, e, v);
        });
      } catch (_) {}
      var fr;
      try { fr = w.frames; } catch (_) { return; }
      for (var i = 0; i < fr.length; i++) {
        var nm = '';
        try { nm = (fr[i].frameElement && (fr[i].frameElement.id || fr[i].frameElement.name)) || ''; } catch (_) {}
        walk(fr[i], path + '>' + i + (nm ? ':' + nm : ''), depth + 1);
      }
    })(window, 'top', 0);
  }

  ui();
  scan();
  setInterval(scan, 2000);   // src 가 바뀐 프레임을 뒤늦게 잡기 위해
  setInterval(watchValues, 600);
})();
