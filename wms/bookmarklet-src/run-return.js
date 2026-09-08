/* 도서도매 반품 — 1~6단계 실행. 즐겨찾기(북마클릿)용.
   화면 오른쪽에 진행 상자를 띄우고, [시작]을 눌러야 실제 작업이 돌아간다.
   중간에 무엇 하나라도 예상과 다르면 멈추고 그 자리를 알려 준다. */
(function () {
  'use strict';

  /* ===================== 여기만 실제 화면에 맞춰 고칩니다 =====================
     값은 CSS 선택자입니다. id 가 있으면 '#아이디', name 뿐이면 '[name=이름]'.
     화면 구조 덤프에서 나온 id/name 을 그대로 옮겨 적으면 됩니다. */
  var CFG = {
    frame: '#mainFrame',            // 업무 화면이 iframe 안이면 그 iframe 선택자, 아니면 null
    tabs: {
      ret:   '#tab_return',         // 도서도매반품조회/등록 탭
      inout: '#tab_inout',          // 반출입등록 탭
      boxin: '#tab_boxin'           // 박스별입고등록 탭
    },
    ret: {
      returnNo: '#txtReturnNo',     // 반품예정번호 입력창
      boxNo:    '#txtBoxNo',        // 채번된 박스번호가 찍히는 칸
      btnSeq:   '#btnBoxSeq',       // 박스번호 채번 버튼
      btnReg:   '#btnReturnReg',    // 반품등록 버튼
      btnReset: '#btnReset'         // 초기화 버튼
    },
    inout: {
      inBoxNo: '#txtInBoxNo'        // 반입박스번호 입력창
    },
    boxin: {
      boxNo:   '#txtBoxInNo',       // 박스번호 입력창
      rowChk:  '#tblIn tbody input[type=checkbox]',  // 반입내역 각 줄의 체크박스
      chkAll:  '#chkAll',           // 전체선택 체크박스 (없으면 null — 줄마다 하나씩 켠다)
      btnSave: '#btnSaveF6'         // 등록(F6) 버튼
    },
    waitMs: 15000,                  // 한 단계를 기다려 주는 최대 시간
    confirmBeforeSave: true         // 5단계 등록 직전에 한 번 물어본다. 익숙해지면 false
  };
  /* ========================================================================= */

  var stopped = false;

  function doc() {
    if (!CFG.frame) return document;
    var f = document.querySelector(CFG.frame);
    if (!f) throw new Error('업무 프레임을 못 찾음: ' + CFG.frame);
    var d = f.contentDocument;
    if (!d) throw new Error('업무 프레임에 접근 불가(교차 출처): ' + CFG.frame);
    return d;
  }
  function win() {
    if (!CFG.frame) return window;
    return document.querySelector(CFG.frame).contentWindow;
  }
  function q(sel, label) {
    var el = doc().querySelector(sel);
    if (!el) throw new Error((label || '요소') + ' 을(를) 못 찾음: ' + sel);
    return el;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(fn, what) {
    var until = Date.now() + CFG.waitMs;
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (stopped) return reject(new Error('사용자가 중단했습니다'));
        var v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve(v);
        if (Date.now() > until) return reject(new Error('기다렸지만 안 됨: ' + what));
        setTimeout(tick, 120);
      })();
    });
  }

  /* 값을 넣을 때 el.value 만 바꾸면 화면이 모르는 경우가 많다.
     React·jQuery 어느 쪽이 붙어 있어도 반응하도록 네이티브 세터로 넣고
     이벤트를 차례로 흘려 준다. */
  function setVal(el, v) {
    var proto = el instanceof win().HTMLTextAreaElement ? win().HTMLTextAreaElement.prototype : win().HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (setter && setter.set) { setter.set.call(el, v); } else { el.value = v; }
    ['input', 'change', 'keyup', 'blur'].forEach(function (t) {
      el.dispatchEvent(new (win().Event)(t, { bubbles: true }));
    });
    el.focus();
  }

  function press(el, key, code) {
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      var ev = new (win().KeyboardEvent)(t, { key: key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    });
  }

  /* 오래된 화면은 click() 만으로는 안 먹고 mousedown/up 을 봐야 하는 것이 있다 */
  function click(el) {
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new (win().MouseEvent)(t, { bubbles: true, cancelable: true, view: win() }));
    });
  }

  /* ---------- 진행 상자 ---------- */
  var box, logEl, btnGo, btnStop;
  function ui() {
    var old = document.getElementById('__wmsRunBox');
    if (old) old.remove();
    box = document.createElement('div');
    box.id = '__wmsRunBox';
    box.setAttribute('style', 'position:fixed;z-index:2147483647;right:16px;top:16px;width:380px;background:#fff;' +
      'border:2px solid #06c;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.35);display:flex;flex-direction:column;' +
      'font-family:"Malgun Gothic",sans-serif;font-size:13px;color:#222');
    var bar = document.createElement('div');
    bar.setAttribute('style', 'padding:8px 12px;background:#06c;color:#fff;font-weight:bold;display:flex;gap:6px;align-items:center');
    bar.textContent = '도서도매 반품';
    var sp = document.createElement('div');
    sp.setAttribute('style', 'flex:1');
    btnGo = document.createElement('button');
    btnGo.textContent = '시작';
    btnGo.setAttribute('style', 'padding:3px 14px;cursor:pointer');
    btnStop = document.createElement('button');
    btnStop.textContent = '중단';
    btnStop.disabled = true;
    btnStop.setAttribute('style', 'padding:3px 14px;cursor:pointer');
    var btnX = document.createElement('button');
    btnX.textContent = '닫기';
    btnX.setAttribute('style', 'padding:3px 10px;cursor:pointer');
    btnX.onclick = function () { stopped = true; box.remove(); };
    logEl = document.createElement('div');
    logEl.setAttribute('style', 'padding:10px;max-height:50vh;overflow:auto;line-height:1.7;white-space:pre-wrap');
    bar.appendChild(sp); bar.appendChild(btnGo); bar.appendChild(btnStop); bar.appendChild(btnX);
    box.appendChild(bar); box.appendChild(logEl);
    document.body.appendChild(box);
  }
  function say(msg, kind) {
    var line = document.createElement('div');
    var color = kind === 'err' ? '#c00' : (kind === 'ok' ? '#0a7' : '#333');
    line.setAttribute('style', 'color:' + color + (kind === 'err' ? ';font-weight:bold' : ''));
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- 실제 절차 ---------- */
  async function run() {
    say('1) 박스번호 채번');
    click(q(CFG.tabs.ret, '반품 탭'));
    await sleep(200);
    var boxField = q(CFG.ret.boxNo, '박스번호 칸');
    var before = boxField.value;
    click(q(CFG.ret.btnSeq, '채번 버튼'));
    var boxNo = await waitFor(function () {
      var v = doc().querySelector(CFG.ret.boxNo).value;
      return (v && v !== before) ? v : false;
    }, '박스번호가 채번되기');
    say('   박스번호 ' + boxNo, 'ok');

    say('2) 반품등록');
    click(q(CFG.ret.btnReg, '반품등록 버튼'));
    await sleep(800);

    say('3) 반출입등록 — 반입박스번호 입력');
    click(q(CFG.tabs.inout, '반출입등록 탭'));
    await sleep(300);
    var inField = q(CFG.inout.inBoxNo, '반입박스번호 칸');
    setVal(inField, boxNo);
    press(inField, 'Enter', 13);
    await sleep(1000);

    say('4) 박스별입고등록 — 박스번호 입력');
    click(q(CFG.tabs.boxin, '박스별입고등록 탭'));
    await sleep(300);
    var biField = q(CFG.boxin.boxNo, '박스번호 칸');
    setVal(biField, boxNo);
    press(biField, 'Enter', 13);

    say('5) 반입내역 전체 체크');
    var rows = await waitFor(function () {
      var r = doc().querySelectorAll(CFG.boxin.rowChk);
      return r.length ? r : false;
    }, '반입내역이 조회되기');
    var n = 0;
    rows.forEach(function (c) { if (!c.checked) { click(c); if (!c.checked) c.checked = true; } n++; });
    say('   ' + n + '건 체크', 'ok');

    if (CFG.confirmBeforeSave) {
      if (!confirm('박스 ' + boxNo + ' — 도서 ' + n + '건을 입고등록합니다.\n\n진행할까요?')) {
        say('사용자가 등록을 취소했습니다. 5단계 앞에서 멈춥니다.', 'err');
        return;
      }
    }
    click(q(CFG.boxin.btnSave, '등록(F6) 버튼'));
    await sleep(1200);
    say('   등록 완료', 'ok');

    say('6) 반품 탭으로 복귀 — 초기화');
    click(q(CFG.tabs.ret, '반품 탭'));
    await sleep(300);
    click(q(CFG.ret.btnReset, '초기화 버튼'));
    await sleep(500);
    var rn = q(CFG.ret.returnNo, '반품예정번호 칸');
    rn.focus();
    rn.select();
    say('끝 — 반품예정번호에 커서를 뒀습니다. 박스 ' + boxNo, 'ok');
  }

  ui();
  say('선택자 확인용으로 먼저 [시작] 전에 화면을 살펴봅니다.');
  try {
    doc();
    say('업무 프레임 확인됨' + (CFG.frame ? ' (' + CFG.frame + ')' : ' (최상위)'), 'ok');
  } catch (e) {
    say(e.message, 'err');
    btnGo.disabled = true;
  }

  btnGo.onclick = function () {
    btnGo.disabled = true;
    btnStop.disabled = false;
    stopped = false;
    run().then(function () {
      btnStop.disabled = true;
    }).catch(function (e) {
      say('멈춤: ' + e.message, 'err');
      say('화면을 확인하고 이어서 손으로 처리하세요. 앞 단계는 이미 반영됐을 수 있습니다.', 'err');
      btnStop.disabled = true;
    });
  };
  btnStop.onclick = function () {
    stopped = true;
    say('중단 요청됨', 'err');
  };
})();
