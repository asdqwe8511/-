/* 화면 구조 뽑기 — 즐겨찾기(북마클릿)용.
   콘솔을 쓰지 않고, 결과를 화면 위 상자에 띄워서 [복사] 버튼으로 가져간다.
   읽기만 한다. 클릭·입력·저장을 하지 않는다. */
(function () {
  var L = [];
  function c(s) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 60) + '…' : s; }
  function lab(e) {
    try {
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
  function vis(e) { try { return !!e.getClientRects().length; } catch (_) { return false; } }
  function fw(w, d) {
    var f = [], g = {
      Nexacro: ['nexacro', 'Nexacro'], WebSquare: ['WebSquare', '$w'], XPLATFORM: ['_pForm'],
      eXbuilder6: ['cpr'], AUIGrid: ['AUIGrid'], RealGrid: ['RealGridJS', 'RealGrid'],
      IBSheet: ['IBSheet', 'createIBSheet'], ExtJS: ['Ext'], jQuery: ['jQuery'], Angular: ['angular'], Vue: ['Vue']
    };
    Object.keys(g).forEach(function (n) {
      if (g[n].some(function (k) { try { return w[k] != null; } catch (_) { return false; } })) f.push(n);
    });
    try { var cv = d.querySelectorAll('canvas').length; if (cv) f.push('canvas x' + cv); } catch (_) {}
    return f.join(', ') || '없음';
  }
  function dump(w, p) {
    var d;
    try { d = w.document; } catch (_) { L.push('[' + p + '] 교차출처 접근불가'); return; }
    if (!d || !d.body) { L.push('[' + p + '] 문서없음'); return; }
    L.push('=== [' + p + '] ' + c(d.title) + ' | ' + c(d.location.href));
    L.push('    프레임워크: ' + fw(w, d) + ' | iframe ' + d.querySelectorAll('iframe,frame').length);
    var n = 0;
    d.querySelectorAll('input,select,textarea').forEach(function (e) {
      if (e.type === 'hidden' || n++ > 120) return;
      L.push('  IN  ' + e.tagName.toLowerCase() + '/' + (e.type || '') + ' id=' + (e.id || '-') + ' name=' + (e.name || '-')
        + (e.readOnly ? ' [읽기전용]' : '') + (vis(e) ? '' : ' [숨김]') + ' 라벨=' + lab(e));
    });
    n = 0;
    d.querySelectorAll('button,input[type=button],input[type=submit],a[onclick],[role=button],[class*=btn]').forEach(function (e) {
      if (n++ > 120) return;
      var t = c(e.tagName === 'INPUT' ? e.value : e.textContent) || c(e.title);
      if (!t) return;
      L.push('  BTN id=' + (e.id || '-') + ' name=' + (e.name || '-') + (vis(e) ? '' : ' [숨김]') + ' 글자="' + t + '"');
    });
    n = 0;
    d.querySelectorAll('[role=tab],[class*=tab] li,[class*=tab] a,[id*=tab]').forEach(function (e) {
      if (n++ > 40) return;
      var t = c(e.textContent);
      if (!t || t.length > 30) return;
      L.push('  TAB id=' + (e.id || '-') + ' 글자="' + t + '"');
    });
    for (var i = 0; i < w.frames.length; i++) {
      var nm = '';
      try { nm = (w.frames[i].frameElement && (w.frames[i].frameElement.id || w.frames[i].frameElement.name)) || ''; } catch (_) {}
      dump(w.frames[i], p + '>' + i + (nm ? ':' + nm : ''));
    }
  }

  dump(window, 'top');
  var out = location.href + '\n' + L.join('\n');

  /* 콘솔 대신 화면에 상자를 띄운다 */
  var old = document.getElementById('__wmsDumpBox');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = '__wmsDumpBox';
  box.setAttribute('style', 'position:fixed;z-index:2147483647;left:5%;top:5%;width:90%;height:88%;background:#fff;' +
    'border:2px solid #0a7;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;' +
    'font-family:"Malgun Gothic",sans-serif;font-size:13px;color:#222');
  var bar = document.createElement('div');
  bar.setAttribute('style', 'padding:8px 12px;background:#0a7;color:#fff;font-weight:bold;display:flex;align-items:center;gap:8px');
  bar.textContent = 'WMS 화면 구조 (' + L.length + '줄)';
  var spacer = document.createElement('div');
  spacer.setAttribute('style', 'flex:1');
  var btnCopy = document.createElement('button');
  btnCopy.textContent = '전체 복사';
  btnCopy.setAttribute('style', 'padding:4px 14px;cursor:pointer;font-size:13px');
  var btnClose = document.createElement('button');
  btnClose.textContent = '닫기';
  btnClose.setAttribute('style', 'padding:4px 14px;cursor:pointer;font-size:13px');
  var ta = document.createElement('textarea');
  ta.setAttribute('style', 'flex:1;margin:0;border:0;border-top:1px solid #ddd;padding:10px;resize:none;' +
    'font-family:Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto');
  ta.value = out;
  ta.readOnly = true;

  btnCopy.onclick = function () {
    ta.readOnly = false;
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.readOnly = true;
    btnCopy.textContent = ok ? '복사됨' : 'Ctrl+C 를 누르세요';
    setTimeout(function () { btnCopy.textContent = '전체 복사'; }, 2500);
  };
  btnClose.onclick = function () { box.remove(); };

  bar.appendChild(spacer);
  bar.appendChild(btnCopy);
  bar.appendChild(btnClose);
  box.appendChild(bar);
  box.appendChild(ta);
  document.body.appendChild(box);
  ta.focus();
  ta.select();
})();
