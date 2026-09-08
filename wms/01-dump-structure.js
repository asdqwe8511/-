/* =========================================================================
 * 통합물류 WMS — 화면 구조 덤프 (1단계)
 *
 * 쓰는 법
 *   1. Edge에서 WMS 화면을 연 상태로 F12 → Console 탭
 *   2. 콘솔이 "붙여넣기를 허용하려면 allow pasting 을 입력하세요" 라고 하면
 *      allow pasting  을 입력하고 엔터
 *   3. 이 파일 내용 전체를 붙여넣고 엔터
 *   4. 마지막에 안내되는 대로 copy(__WMS_DUMP_JSON) 실행 → 클립보드에 복사됨
 *   5. 그 내용을 그대로 대화창에 붙여넣어 주세요
 *
 * 이 스크립트는 화면을 읽기만 합니다. 클릭·입력·저장을 하지 않습니다.
 * ========================================================================= */
(function () {
  'use strict';

  var MAX_STR = 90;          // 문자열 자르는 길이
  var MAX_PER_KIND = 250;    // 프레임당 종류별 최대 수집 개수

  function cut(s) {
    if (s == null) return null;
    s = String(s).replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > MAX_STR ? s.slice(0, MAX_STR) + '…' : s;
  }

  function isVisible(el) {
    try {
      if (!el.getClientRects().length) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (e) { return false; }
  }

  /* 입력창 옆에 붙어 있는 라벨 글자를 최대한 찾아낸다.
     한국 SI 화면은 <th>제목</th><td><input></td> 형태가 압도적으로 많다. */
  function labelOf(el) {
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) return cut(l.textContent);
      }
      var lab = el.closest('label');
      if (lab) return cut(lab.textContent);

      var td = el.closest('td,div,span');
      // 같은 행의 앞쪽 th 또는 td
      var tr = el.closest('tr');
      if (tr && td) {
        var cells = Array.prototype.slice.call(tr.children);
        var i = cells.indexOf(el.closest('td,th'));
        for (var k = i - 1; k >= 0; k--) {
          var t = cut(cells[k].textContent);
          if (t) return t;
        }
      }
      // 바로 앞 형제 요소
      var prev = el.previousElementSibling;
      while (prev) {
        var pt = cut(prev.textContent);
        if (pt) return pt;
        prev = prev.previousElementSibling;
      }
      // 부모의 바로 앞 형제
      var p = el.parentElement;
      if (p && p.previousElementSibling) return cut(p.previousElementSibling.textContent);
    } catch (e) {}
    return null;
  }

  function cssPath(el) {
    try {
      var parts = [];
      var cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        var seg = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift(seg + '#' + cur.id); break; }
        var cls = (cur.className && typeof cur.className === 'string')
          ? cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        if (cls) seg += '.' + cls;
        var par = cur.parentElement;
        if (par) {
          var same = Array.prototype.filter.call(par.children, function (c) { return c.tagName === cur.tagName; });
          if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return null; }
  }

  function clsOf(el) {
    var c = el.getAttribute && el.getAttribute('class');
    return c ? cut(c) : null;
  }

  function describeInput(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      id: el.id || null,
      name: el.name || null,
      cls: clsOf(el),
      placeholder: el.placeholder || null,
      title: el.title || null,
      label: labelOf(el),
      value: cut(el.value),
      readOnly: !!el.readOnly,
      disabled: !!el.disabled,
      maxLength: el.maxLength > 0 && el.maxLength < 500 ? el.maxLength : null,
      visible: isVisible(el),
      path: cssPath(el)
    };
  }

  function describeClickable(el) {
    var txt = cut(el.value && el.tagName === 'INPUT' ? el.value : el.textContent) || cut(el.title) || cut(el.getAttribute('alt'));
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      id: el.id || null,
      name: el.name || null,
      cls: clsOf(el),
      text: txt,
      href: el.getAttribute && el.getAttribute('href') ? cut(el.getAttribute('href')) : null,
      onclick: el.getAttribute && el.getAttribute('onclick') ? cut(el.getAttribute('onclick')) : null,
      visible: isVisible(el),
      path: cssPath(el)
    };
  }

  /* 화면에서 쓰는 UI 프레임워크를 알아낸다.
     Nexacro / WebSquare 처럼 캔버스로 그리는 물건이면
     DOM 자동화 방식 자체가 달라지므로 먼저 확인해야 한다. */
  function detectFramework(win, doc) {
    var found = [];
    function has(k) { try { return typeof win[k] !== 'undefined' && win[k] !== null; } catch (e) { return false; } }
    var globals = {
      'Nexacro': ['nexacro', 'Nexacro'],
      'XPLATFORM/miPlatform': ['_pForm', 'application'],
      'WebSquare': ['WebSquare', '$w', '$p'],
      'eXbuilder6': ['cpr'],
      'AUIGrid': ['AUIGrid'],
      'RealGrid': ['RealGridJS', 'RealGrid'],
      'IBSheet': ['IBSheet', 'createIBSheet', 'IBS_InitSheet'],
      'ExtJS': ['Ext'],
      'jQuery': ['jQuery', '$'],
      'AngularJS': ['angular'],
      'Vue': ['Vue'],
      'dhtmlx': ['dhtmlx'],
      'w2ui': ['w2ui'],
      'Handsontable': ['Handsontable'],
      'TOAST Grid': ['tui']
    };
    Object.keys(globals).forEach(function (nameOfLib) {
      if (globals[nameOfLib].some(has)) found.push(nameOfLib);
    });
    try {
      var body = doc.body;
      if (body && Object.keys(body).some(function (k) { return k.indexOf('__react') === 0; })) found.push('React');
    } catch (e) {}
    try {
      if (doc.querySelector('canvas')) found.push('canvas 사용(' + doc.querySelectorAll('canvas').length + '개)');
    } catch (e) {}
    return found;
  }

  /* 탭으로 보이는 것들. role=tab, 클래스에 tab, 또는 업무 키워드가 들어간 클릭 대상. */
  var TAB_WORDS = ['반품', '반출입', '박스', '입고', '조회', '등록', '반입', '도매'];
  function collectTabs(doc) {
    var out = [];
    var seen = new Set();
    function push(el, why) {
      if (seen.has(el)) return;
      seen.add(el);
      var d = describeClickable(el);
      d.why = why;
      out.push(d);
    }
    try {
      doc.querySelectorAll('[role="tab"]').forEach(function (el) { push(el, 'role=tab'); });
      doc.querySelectorAll('[class*="tab" i] a, [class*="tab" i] li, [class*="tab" i] button, [id*="tab" i]').forEach(function (el) {
        if (out.length < MAX_PER_KIND) push(el, 'class/id에 tab');
      });
      doc.querySelectorAll('a, li, button, span, div').forEach(function (el) {
        if (out.length >= MAX_PER_KIND) return;
        if (el.children.length > 2) return;               // 컨테이너는 제외
        var t = (el.textContent || '').replace(/\s+/g, '');
        if (!t || t.length > 30) return;
        if (TAB_WORDS.filter(function (w) { return t.indexOf(w) >= 0; }).length >= 2) push(el, '업무 키워드: ' + t);
      });
    } catch (e) {}
    return out.slice(0, MAX_PER_KIND);
  }

  function collectGrids(doc) {
    var out = [];
    try {
      doc.querySelectorAll('[class*="grid" i], [class*="sheet" i], [id*="grid" i], [id*="sheet" i], table').forEach(function (el) {
        if (out.length >= 60) return;
        if (el.tagName === 'TABLE' && el.rows.length < 2) return;
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: clsOf(el),
          rows: el.rows ? el.rows.length : null,
          checkboxes: el.querySelectorAll('input[type=checkbox]').length,
          headerText: cut((el.querySelector('thead, [class*="head" i]') || {}).textContent),
          visible: isVisible(el),
          path: cssPath(el)
        });
      });
    } catch (e) {}
    return out;
  }

  function dumpFrame(win, path) {
    var doc;
    try { doc = win.document; } catch (e) {
      return { frame: path, error: '교차 출처(cross-origin) — 접근 불가', src: (function () { try { return win.frameElement && win.frameElement.src; } catch (e2) { return null; } })() };
    }
    if (!doc || !doc.body) return { frame: path, error: '문서 없음' };

    var inputs = [];
    try {
      doc.querySelectorAll('input, select, textarea').forEach(function (el) {
        if (inputs.length >= MAX_PER_KIND) return;
        if (el.type === 'hidden') return;
        inputs.push(describeInput(el));
      });
    } catch (e) {}

    var buttons = [];
    try {
      doc.querySelectorAll('button, input[type=button], input[type=submit], a[onclick], [role="button"], [class*="btn" i]').forEach(function (el) {
        if (buttons.length >= MAX_PER_KIND) return;
        buttons.push(describeClickable(el));
      });
    } catch (e) {}

    return {
      frame: path,
      url: cut(doc.location && doc.location.href),
      title: cut(doc.title),
      framework: detectFramework(win, doc),
      tabs: collectTabs(doc),
      inputs: inputs,
      buttons: buttons,
      grids: collectGrids(doc),
      counts: {
        input: doc.querySelectorAll('input,select,textarea').length,
        button: doc.querySelectorAll('button,input[type=button],input[type=submit]').length,
        iframe: doc.querySelectorAll('iframe,frame').length,
        canvas: doc.querySelectorAll('canvas').length
      }
    };
  }

  function walk(win, path, acc, depth) {
    if (depth > 4 || acc.length > 25) return;
    acc.push(dumpFrame(win, path));
    var kids;
    try { kids = win.frames; } catch (e) { return; }
    for (var i = 0; i < kids.length; i++) {
      var name = null;
      try { name = kids[i].frameElement && (kids[i].frameElement.name || kids[i].frameElement.id); } catch (e) {}
      walk(kids[i], path + ' > [' + i + (name ? ':' + name : '') + ']', acc, depth + 1);
    }
  }

  var frames = [];
  walk(window, 'top', frames, 0);

  var result = {
    수집시각: new Date().toISOString(),
    최상위URL: location.href,
    브라우저: navigator.userAgent,
    프레임수: frames.length,
    프레임: frames
  };

  var json = JSON.stringify(result, null, 1);
  window.__WMS_DUMP = result;
  window.__WMS_DUMP_JSON = json;

  console.log('%c통합물류 WMS 화면 구조 덤프 완료', 'font-size:14px;font-weight:bold;color:#0a7');
  console.log('프레임 ' + frames.length + '개, JSON ' + json.length.toLocaleString() + '자');
  frames.forEach(function (f) {
    console.log('  · ' + f.frame + ' — ' + (f.error || (f.title || '(제목없음)') + ' | 프레임워크: ' + (f.framework.join(', ') || '없음') + ' | 입력 ' + f.counts.input + ', 버튼 ' + f.counts.button + ', iframe ' + f.counts.iframe));
  });
  console.log('%c다음 줄을 콘솔에 실행해서 클립보드로 복사하세요:', 'font-weight:bold');
  console.log('%c    copy(__WMS_DUMP_JSON)', 'color:#06c;font-family:monospace');
  console.log('(복사가 안 되면  __WMS_DUMP  를 실행해 펼쳐 보고 화면을 캡처해 주셔도 됩니다)');

  return result;
})();
