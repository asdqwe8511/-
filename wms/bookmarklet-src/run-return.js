/* 도서도매 반품 — 1~6단계 자동 실행. 크롬 즐겨찾기(북마클릿)용.
   [시작] 한 번이면 채번부터 초기화까지 이어서 돈다.

   이 화면(kbwms)은 확인창이 브라우저 팝업이 아니라 화면 안 버튼이다.
   그래서 자동화가 그 버튼도 눌러야 하는데, 아무 창이나 누르면 위험하다.
   미리 알고 있는 문구가 뜬 창만 누르고, 모르는 문구면 멈추고 보여 준다. */
(function () {
  'use strict';

  /* ===================== 화면에 맞춘 값 =====================
     녹화 기록에서 그대로 옮겨 적었다. 화면이 바뀌면 여기만 고치면 된다. */
  var CFG = {
    tabs: {
      ret:   '#mf_wdc_main_nameLayer_mf_wdc_main_subWindow1',   // 도서도매반품조회/등록
      inout: '#mf_wdc_main_nameLayer_mf_wdc_main_subWindow2',   // 반출입등록
      boxin: '#mf_wdc_main_nameLayer_mf_wdc_main_subWindow3'    // 박스별 입고 등록
    },
    s1: {
      btnSeq: '#mf_wdc_main_subWindow1_wframe_btn_boxNum',      // 박스번호 채번
      boxNo:  '#mf_wdc_main_subWindow1_wframe_ibx_boxNum'       // 채번된 번호가 찍히는 칸
    },
    s2: { btnSave: '#mf_wdc_main_subWindow1_wframe_btn_rtgdSave' },   // 반품등록
    s3: { inBoxNo: '#mf_wdc_main_subWindow2_wframe_ibx_saveBoxNum' }, // 반입박스번호
    s4: { boxNo:   '#mf_wdc_main_subWindow3_wframe_txt_boxNum' },     // 박스번호
    s5: {
      chkAll:  null,                                            // 반입내역 전체선택 — [체크박스 지정] 으로 정한다
      btnSave: '#mf_wdc_main_subWindow3_wframe_btn_save'        // 입고등록
    },
    s6: {
      btnInit:  '#mf_wdc_main_subWindow1_wframe_btn_init',      // 초기화
      returnNo: '#mf_wdc_main_subWindow1_wframe_ibx_rtgdSchdNum'// 반품예정번호
    },
    /* 눌러도 되는 확인창 문구. 여기 없는 창이 뜨면 멈춘다. */
    okDialogs: [
      /반품등록이\s*완료/,
      /반입등록이\s*완료/,
      /입고등록이\s*완료/,
      /서가번호\s*\d+\s*에\s*등록\s*하시겠습니까/
    ],
    waitMs: 40000,        // 한 단계를 기다려 주는 최대 시간
    settleMs: 5000,       // 조회를 걸고 목록이 그려지기를 기다리는 시간
    listRetryMs: 30000    // 전체선택이 걸릴 때까지 다시 눌러 보는 시간
  };
  /* ========================================================= */

  var LS = '__wmsRunCfg';
  /* 저장된 값이라도 그대로 믿지 않는다. 지난 판에서 제 패널의 버튼을 집어 저장한
     일이 있었고, 그걸 전체선택인 줄 알고 계속 눌러댔다. */
  function usable(sel) {
    if (!sel) return false;
    if (sel.indexOf('__wmsRunBox') >= 0) return false;
    var el;
    try { el = document.querySelector(sel); } catch (e) { return false; }
    return !!(el && el.type === 'checkbox');
  }
  try {
    var saved = JSON.parse(localStorage.getItem(LS) || '{}');
    if (saved.chkAll) {
      if (usable(saved.chkAll) || saved.chkAll.indexOf('__wmsRunBox') < 0) CFG.s5.chkAll = saved.chkAll;
    }
  } catch (e) {}
  function remember() {
    try { localStorage.setItem(LS, JSON.stringify({ chkAll: CFG.s5.chkAll })); } catch (e) {}
  }

  var stopped = false;

  /* ---------- 기본 도구 ---------- */
  function q(sel) { return sel ? document.querySelector(sel) : null; }
  function need(sel, what) {
    var el = q(sel);
    if (!el) throw new Error(what + ' 을(를) 못 찾음: ' + sel);
    return el;
  }
  function vis(el) {
    if (!el) return false;
    try {
      if (!el.getClientRects().length) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (e) { return false; }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, what) {
    var until = Date.now() + CFG.waitMs;
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (stopped) return reject(new Error('중단했습니다'));
        var v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve(v);
        if (Date.now() > until) return reject(new Error('기다렸지만 안 됨: ' + what));
        setTimeout(tick, 150);
      })();
    });
  }

  /* Nexacro 계열은 click() 하나로는 안 먹는 것이 있어 눌렀다 떼는 과정을 다 보낸다 */
  function click(el) {
    var o = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var E = t.indexOf('pointer') === 0 ? window.PointerEvent : window.MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch (e) {}
    });
  }

  /* 값은 한 자씩 쳐 넣는다. value 만 바꿔 놓으면 화면이 모르는 경우가 많다. */
  async function typeInto(el, text) {
    el.focus();
    el.click();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    function put(v) { if (setter && setter.set) setter.set.call(el, v); else el.value = v; }
    put('');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      put(el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(15);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pressEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    });
  }

  /* ---------- 화면 안 확인창 ---------- */
  var DLG = 'input[type=button][id*="_btn_confirm"],input[type=button][id*="_btn_yes"],input[type=button][id*="_btn_ok"]';
  function findDialog() {
    var list = [].slice.call(document.querySelectorAll(DLG)).filter(vis);
    return list.length ? list[list.length - 1] : null;   // 여러 겹이면 맨 위 것
  }
  /* 확인창 문구는 버튼 옆에 있다. 버튼이 든 상자의 글자에서 버튼 글자를 뺀다. */
  function dialogText(btn) {
    var box = btn.parentElement;
    for (var i = 0; i < 3 && box; i++) {
      var t = (box.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 4) return t;
      box = box.parentElement;
    }
    return '(문구를 못 읽음)';
  }
  async function handleDialog(what) {
    var btn = await waitFor(findDialog, what + ' 확인창');
    var msg = dialogText(btn);
    var allowed = CFG.okDialogs.some(function (re) { return re.test(msg); });
    if (!allowed) throw new Error('모르는 확인창이 떴습니다 — "' + msg + '"');
    say('   확인창: ' + msg, 'dim');
    click(btn);
    await sleep(400);
    return msg;
  }
  /* 단계를 시작하기 전에 남아 있는 창이 없어야 한다 */
  function assertNoDialog() {
    var btn = findDialog();
    if (btn) throw new Error('확인창이 떠 있습니다 — "' + dialogText(btn) + '"');
  }

  /* 전체선택이 실제로 걸렸는지는 문서 전체의 체크된 수로 센다.
     그리드 경계를 DOM 모양만 보고 알아내려 하면 옆 그리드까지 끌어오게 된다 —
     화면에 표가 둘 있는데 헤더 체크박스는 둘 다 id 가 없어서 구별되지 않는다. */
  function countChecked() { return document.querySelectorAll('input[type=checkbox]:checked').length; }

  /* ---------- 요소 집어주기 ---------- */
  function pathOf(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var par = cur.parentElement;
      var seg = cur.tagName.toLowerCase();
      if (par) {
        var same = [].filter.call(par.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = par;
    }
    return parts.join(' > ');
  }
  var picking = false;
  function pick(onDone) {
    if (picking) { say('이미 지정을 기다리는 중입니다. 화면의 체크박스를 클릭하거나 Esc 를 누르세요.', 'err'); return; }
    picking = true;
    say('박스별입고등록 탭에서 반입내역의 전체선택 체크박스를 클릭하세요. (Esc 로 취소)', 'ok');
    say('체크박스가 아닌 곳을 누르면 그냥 무시하고 계속 기다립니다.', 'dim');

    function esc(e) { if (e.key === 'Escape') { off(); say('지정을 취소했습니다.', 'err'); } }
    function grab(e) {
      var t = e.target;
      /* 이 상자 안은 절대 집지 않는다. 지난 판에서 [체크박스 지정] 버튼 자신을
         집어 저장하는 바람에, 자동화가 제 버튼을 계속 눌러댔다. */
      if (t && t.closest && t.closest('#__wmsRunBox')) return;
      e.preventDefault();
      e.stopPropagation();

      // 체크박스가 아니면 무시하고 계속 기다린다 — 잘못 집느니 기다리는 편이 낫다
      var cb = (t && t.type === 'checkbox') ? t
             : (t && t.querySelector ? t.querySelector('input[type=checkbox]') : null);
      if (!cb) { say('여기는 체크박스가 아닙니다. 전체선택 체크박스를 눌러 주세요.', 'err'); return; }

      var sel = pathOf(cb);
      var back;
      try { back = document.querySelector(sel); } catch (err) { back = null; }
      if (back !== cb) { say('이 자리를 다시 찾을 방법을 못 만들었습니다. 다른 곳을 눌러 보세요.', 'err'); return; }
      off();
      onDone(sel);
    }
    function off() {
      picking = false;
      document.removeEventListener('click', grab, true);
      document.removeEventListener('keydown', esc, true);
      document.body.style.cursor = '';
      if (statEl) status();
    }
    document.body.style.cursor = 'crosshair';
    // 지금 이 클릭이 그대로 집히지 않도록 한 박자 뒤에 귀를 연다
    setTimeout(function () {
      document.addEventListener('click', grab, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  /* ---------- 점검 ---------- */
  async function check() {
    var rows = [
      ['도서도매반품 탭', CFG.tabs.ret], ['반출입등록 탭', CFG.tabs.inout], ['박스별입고 탭', CFG.tabs.boxin]
    ];
    var bad = 0;
    say('탭부터 봅니다.');
    rows.forEach(function (r) {
      var el = q(r[1]);
      if (el) { say('  O ' + r[0], 'ok'); } else { say('  X ' + r[0] + ' — ' + r[1], 'err'); bad++; }
    });
    var per = [
      [CFG.tabs.ret, [['채번 버튼', CFG.s1.btnSeq], ['박스번호 칸', CFG.s1.boxNo],
                      ['반품등록 버튼', CFG.s2.btnSave], ['초기화 버튼', CFG.s6.btnInit],
                      ['반품예정번호 칸', CFG.s6.returnNo]]],
      [CFG.tabs.inout, [['반입박스번호 칸', CFG.s3.inBoxNo]]],
      [CFG.tabs.boxin, [['박스번호 칸', CFG.s4.boxNo], ['입고등록 버튼', CFG.s5.btnSave],
                        ['반입내역 전체선택', CFG.s5.chkAll]]]
    ];
    for (var i = 0; i < per.length; i++) {
      var tab = q(per[i][0]);
      if (tab) { click(tab); await sleep(600); }
      say('탭을 열고 그 안을 봅니다.');
      per[i][1].forEach(function (r) {
        if (!r[1]) { say('  ? ' + r[0] + ' — 아직 안 정했습니다. [체크박스 지정] 을 누르세요.', 'err'); bad++; return; }
        var el = q(r[1]);
        if (el && vis(el)) { say('  O ' + r[0], 'ok'); }
        else if (el) { say('  △ ' + r[0] + ' — 있지만 안 보임(탭을 열면 보일 수 있음)'); }
        else { say('  X ' + r[0] + ' — ' + r[1], 'err'); bad++; }
      });
    }
    click(need(CFG.tabs.ret, '반품 탭'));
    say(bad ? '못 찾은 것이 ' + bad + '개입니다. 이대로 시작하면 그 자리에서 멈춥니다.' : '전부 찾았습니다. [시작] 해도 됩니다.', bad ? 'err' : 'ok');
  }

  /* ---------- 본 작업 ---------- */
  /* 채번 버튼은 사람이 누른다. 자동화는 번호가 찍힌 것을 보고 그 뒤를 잇는다. */
  async function cycle(boxNo) {
    if (!CFG.s5.chkAll) throw new Error('반입내역 전체선택 체크박스를 아직 안 정했습니다. [체크박스 지정] 을 먼저 누르세요.');
    say('1) 박스번호 채번 — 번호를 받았습니다');
    say('   박스번호 ' + boxNo, 'ok');
    assertNoDialog();

    say('2) 반품등록');
    click(need(CFG.s2.btnSave, '반품등록 버튼'));
    await handleDialog('반품등록');

    say('3) 반출입등록 — 반입박스번호 입력');
    click(need(CFG.tabs.inout, '반출입등록 탭'));
    await sleep(600);
    var f3 = need(CFG.s3.inBoxNo, '반입박스번호 칸');
    await typeInto(f3, boxNo);
    pressEnter(f3);
    say('   반입등록은 서버가 느립니다. 기다립니다…', 'dim');
    await handleDialog('반입등록');

    say('4) 박스별입고등록 — 박스번호 입력');
    click(need(CFG.tabs.boxin, '박스별입고 탭'));
    await sleep(600);
    var f4 = need(CFG.s4.boxNo, '박스번호 칸');
    await typeInto(f4, boxNo);
    pressEnter(f4);

    say('5) 반입내역 전체 체크');
    if (CFG.s5.chkAll.indexOf('__wmsRunBox') >= 0) {
      throw new Error('지정된 것이 이 상자 안의 버튼입니다. [체크박스 지정] 으로 화면의 체크박스를 다시 골라 주세요.');
    }
    var chk = await waitFor(function () {
      var el = q(CFG.s5.chkAll);
      return (el && vis(el)) ? el : false;
    }, '전체선택 체크박스가 보이기');
    if (chk.type !== 'checkbox') throw new Error('지정된 것이 체크박스가 아닙니다 (' + chk.tagName.toLowerCase() + '). 다시 지정해 주세요.');
    say('   ' + (CFG.settleMs / 1000) + '초 기다린 뒤 전체선택을 겁니다', 'dim');
    /* 이 화면의 그리드는 줄을 미리 만들어 두고 값만 채운다. 그래서 "체크박스가
       늘어나면 조회된 것" 같은 신호가 오지 않는다. 조회를 기다리는 대신
       전체선택을 눌러 보고 실제로 걸렸는지를 확인한다. 안 걸렸으면 다시 누른다. */
    await sleep(CFG.settleMs);
    var gained = 0;
    var until = Date.now() + CFG.listRetryMs;
    var tries = 0;
    while (Date.now() < until) {
      if (stopped) throw new Error('중단했습니다');
      tries++;
      // 지난 번 체크가 남아 켜져 있으면 눌러도 아무 일이 없다. 껐다가 다시 켠다.
      if (chk.checked) { click(chk); await sleep(300); }
      var checkedBefore = countChecked();
      click(chk);
      await sleep(600);
      gained = countChecked() - checkedBefore;
      if (gained > 1) break;
      /* 줄마다 직접 눌러 보는 대비책은 두지 않는다. 이 그리드는 줄을 미리
         그려 두기 때문에, 아직 값이 안 들어온 빈 줄까지 전부 체크하게 된다.
         전체선택은 값이 있는 줄만 고르므로, 될 때까지 그것만 다시 누른다. */
      await sleep(900);
    }
    if (gained <= 1) throw new Error('반입내역이 체크되지 않았습니다 (' + tries + '번 시도). ' +
      '목록이 비어 있거나, 지정한 전체선택 체크박스가 다른 표의 것일 수 있습니다.');
    say('   ' + (gained - 1) + '건 체크' + (tries > 1 ? ' (' + tries + '번째 시도)' : ''), 'ok');

    click(need(CFG.s5.btnSave, '입고등록 버튼'));
    // 버튼이 안 먹는 경우를 대비해 F6 도 한 번 보낸다
    var appeared = await Promise.race([
      waitFor(findDialog, '입고등록 확인창').then(function () { return true; }).catch(function () { return false; }),
      sleep(3000).then(function () { return false; })
    ]);
    if (!appeared && !findDialog()) {
      say('   버튼에 반응이 없어 F6 을 보냅니다', 'dim');
      ['keydown', 'keyup'].forEach(function (t) {
        document.dispatchEvent(new KeyboardEvent(t, { key: 'F6', code: 'F6', keyCode: 117, which: 117, bubbles: true, cancelable: true }));
      });
    }
    await handleDialog('입고등록 여부');
    await handleDialog('입고등록 완료');

    say('6) 반품 탭 복귀 · 초기화');
    click(need(CFG.tabs.ret, '반품 탭'));
    await sleep(500);
    click(need(CFG.s6.btnInit, '초기화 버튼'));
    await sleep(700);
    assertNoDialog();
    var rn = need(CFG.s6.returnNo, '반품예정번호 칸');
    rn.focus();
    try { rn.select(); } catch (e) {}
    say('끝 — 박스 ' + boxNo + '. 반품예정번호에 커서를 뒀습니다.', 'ok');
    say('대기 중 — 박스번호 채번을 누르면 다음 건을 이어서 돕니다.', 'ok');
  }

  /* ---------- 상자 ---------- */
  var box, logEl, statEl, btnGo, btnChk, btnPick, btnStop;
  var armed = false, running = false, lastBox = '';
  function say(msg, kind) {
    var d = document.createElement('div');
    d.style.color = kind === 'err' ? '#c00' : (kind === 'ok' ? '#0a7' : (kind === 'dim' ? '#888' : '#333'));
    if (kind === 'err') d.style.fontWeight = 'bold';
    d.textContent = msg;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function mkBtn(label) {
    var b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('style', 'padding:3px 10px;cursor:pointer;font-size:12px');
    return b;
  }
  function busy(on) {
    btnChk.disabled = on;
    btnPick.disabled = on;
    btnStop.disabled = !on;
  }
  function paintArm() {
    btnGo.textContent = armed ? '■ 대기 중지' : '● 대기 시작';
    box.style.borderColor = armed ? '#0a7' : '#06c';
    box.querySelector('div').style.background = armed ? '#0a7' : '#06c';
    status();
  }
  /* 아무 일도 안 일어날 때 왜 그런지 보이게 한다.
     대기 중인지, 박스번호 칸을 제대로 보고 있는지, 지금 그 칸에 무엇이 있는지. */
  function status() {
    if (!statEl) return;
    var el = q(CFG.s1.boxNo);
    var txt;
    if (running) { txt = '작업 중…'; }
    else if (!armed) { txt = '대기 안 함 — [● 대기 시작] 을 누르세요'; }
    else if (!el) { txt = '박스번호 칸을 못 찾음: ' + CFG.s1.boxNo; }
    else { txt = '대기 중 — 박스번호 칸: ' + (el.value ? '"' + el.value + '"' : '(비어 있음)'); }
    statEl.textContent = txt;
    statEl.style.color = running ? '#06c' : (armed ? '#0a7' : '#888');
    statEl.style.background = armed || running ? '#f2fbf8' : '#fafafa';
  }

  /* 방아쇠는 클릭이 아니라 "박스번호 칸에 새 번호가 찍히는 것"이다.
     클릭을 잡으려면 화면이 이벤트를 어떻게 흘리는지에 기대게 되는데,
     번호는 어떤 경로로 눌렸든 반드시 그 칸에 들어온다. */
  function tick() {
    status();
    if (!armed || running) return;
    var el = q(CFG.s1.boxNo);
    if (!el) return;
    var v = (el.value || '').trim();
    if (!v) { lastBox = ''; return; }      // 초기화되면 다음 번호를 새것으로 본다
    if (v === lastBox) return;
    lastBox = v;
    start(v);
  }

  function start(boxNo) {
    running = true;
    logEl.textContent = '';
    busy(true);
    status();
    cycle(boxNo).catch(function (e) {
      say('멈춤: ' + e.message, 'err');
      say('화면을 확인하고 남은 것은 손으로 처리하세요. 앞 단계는 이미 반영됐을 수 있습니다.', 'err');
      say('대기는 계속합니다. 다음 건은 박스번호 채번을 누르면 됩니다.', 'dim');
    }).then(function () {
      running = false;
      stopped = false;
      busy(false);
      status();
    });
  }

  /* 클릭 자체는 방아쇠가 아니지만, 대기를 안 걸어 둔 채 채번을 누르면
     아무 일도 안 일어난다. 그때 그냥 조용히 있지 말고 이유를 말해 준다. */
  function onClick(ev) {
    if (armed || running) return;
    var btn = q(CFG.s1.btnSeq);
    if (!btn) return;
    if (ev.target !== btn && !btn.contains(ev.target)) return;
    say('박스번호채번을 눌렀지만 대기 상태가 아닙니다. [● 대기 시작] 을 먼저 누르세요.', 'err');
  }
  function ui() {
    var old = document.getElementById('__wmsRunBox');
    if (old) old.remove();
    box = document.createElement('div');
    box.id = '__wmsRunBox';
    box.setAttribute('style', 'position:fixed;z-index:2147483647;right:14px;top:14px;width:430px;height:400px;background:#fff;' +
      'border:2px solid #06c;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;' +
      'font-family:"Malgun Gothic",sans-serif;font-size:12px;color:#222');
    var bar = document.createElement('div');
    bar.setAttribute('style', 'padding:6px 10px;background:#06c;color:#fff;font-weight:bold;display:flex;gap:5px;' +
      'align-items:center;flex-wrap:wrap;cursor:move');
    var ttl = document.createElement('span');
    ttl.textContent = '도서도매 반품';
    var sp = document.createElement('div');
    sp.setAttribute('style', 'flex:1');
    btnChk = mkBtn('점검');
    btnPick = mkBtn('체크박스 지정');
    btnGo = mkBtn('● 대기 시작');
    btnGo.style.fontWeight = 'bold';
    btnStop = mkBtn('중단');
    btnStop.disabled = true;
    var btnX = mkBtn('닫기');
    btnX.onclick = function () { stopped = true; box.remove(); };
    statEl = document.createElement('div');
    statEl.setAttribute('style', 'padding:5px 10px;border-bottom:1px solid #eee;font-weight:bold');
    logEl = document.createElement('div');
    logEl.setAttribute('style', 'flex:1;padding:9px;overflow:auto;line-height:1.75;white-space:pre-wrap');
    bar.appendChild(ttl); bar.appendChild(sp);
    bar.appendChild(btnChk); bar.appendChild(btnPick); bar.appendChild(btnGo); bar.appendChild(btnStop); bar.appendChild(btnX);
    box.appendChild(bar); box.appendChild(statEl); box.appendChild(logEl);
    document.body.appendChild(box);

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
    });
    document.addEventListener('mouseup', function () { drag = null; });

    function wrap(fn) {
      return function () {
        stopped = false;
        logEl.textContent = '';   // 한 번 돌 때마다 새로 적는다. 지난 기록이 섞이면 헷갈린다.
        busy(true);
        fn().catch(function (e) {
          say('멈춤: ' + e.message, 'err');
          say('화면을 확인하고 남은 것은 손으로 처리하세요. 앞 단계는 이미 반영됐을 수 있습니다.', 'err');
        }).then(function () { busy(false); });
      };
    }
    btnChk.onclick = wrap(check);
    btnGo.onclick = function () {
      armed = !armed;
      paintArm();
      if (armed) {
        logEl.textContent = '';
        var el = q(CFG.s1.boxNo);
        lastBox = el ? (el.value || '').trim() : '';
        say('대기 중 — 화면의 [박스번호채번] 을 누르면 그때부터 자동으로 돕니다.', 'ok');
        say('한 바퀴 돌고 반품예정번호에 커서가 오면 다시 대기합니다.', 'dim');
        if (!el) say('박스번호 칸을 못 찾았습니다: ' + CFG.s1.boxNo + ' — [점검] 을 눌러 보세요.', 'err');
        else if (lastBox) say('지금 박스번호 칸에 "' + lastBox + '" 이 있습니다. 채번을 다시 누르면 그때부터 돕니다.', 'dim');
      } else {
        say('대기를 그쳤습니다.', 'err');
      }
    };
    btnStop.onclick = function () { stopped = true; say('중단 요청됨', 'err'); };
    document.addEventListener('click', onClick, true);
    setInterval(tick, 400);
    paintArm();
    btnPick.onclick = function () {
      var t = q(CFG.tabs.boxin);
      if (t) { click(t); }        // 지정하려면 그 탭이 열려 있어야 한다
      pick(function (sel) {
        CFG.s5.chkAll = sel;
        remember();
        say('전체선택 체크박스를 정했습니다: ' + sel, 'ok');
        say('이 설정은 이 브라우저에 저장돼서 다음에도 그대로 씁니다.', 'dim');
      });
    };
  }

  ui();
  say('처음이면 [점검] 부터 눌러 보세요. 화면을 바꾸지 않고 자리만 확인합니다.');
  say('[● 대기 시작] 을 누른 뒤 화면의 [박스번호채번] 을 누르면 한 바퀴 돕니다.');
  if (CFG.s5.chkAll && CFG.s5.chkAll.indexOf('__wmsRunBox') >= 0) {
    CFG.s5.chkAll = null;
    remember();
    say('저장돼 있던 지정이 이 상자 안의 버튼이었습니다. 지웠으니 다시 지정해 주세요.', 'err');
  } else if (CFG.s5.chkAll) { say('전체선택 체크박스: ' + CFG.s5.chkAll, 'dim'); }
  else say('반입내역 전체선택 체크박스는 id 가 없어서 한 번 지정해야 합니다 — [체크박스 지정]', 'err');
})();
