/* WMS 화면 구조 — 간단 버전. Edge 콘솔에 붙여넣고 엔터. 읽기만 함. */
(function(){var L=[];function c(s){s=(s||'').replace(/\s+/g,' ').trim();return s.length>60?s.slice(0,60)+'…':s}
function lab(e){try{var r=e.closest('tr'),t=e.closest('td,th');if(r&&t){var a=[].slice.call(r.children),i=a.indexOf(t);
for(var k=i-1;k>=0;k--){var x=c(a[k].textContent);if(x)return x}}var p=e.previousElementSibling;
while(p){var y=c(p.textContent);if(y)return y;p=p.previousElementSibling}
if(e.parentElement&&e.parentElement.previousElementSibling)return c(e.parentElement.previousElementSibling.textContent)}catch(_){}return''}
function vis(e){try{return!!e.getClientRects().length}catch(_){return false}}
function fw(w,d){var f=[],g={Nexacro:['nexacro','Nexacro'],WebSquare:['WebSquare','$w'],XPLATFORM:['_pForm'],
eXbuilder6:['cpr'],AUIGrid:['AUIGrid'],RealGrid:['RealGridJS','RealGrid'],IBSheet:['IBSheet','createIBSheet'],
ExtJS:['Ext'],jQuery:['jQuery'],Angular:['angular'],Vue:['Vue']};
Object.keys(g).forEach(function(n){if(g[n].some(function(k){try{return w[k]!=null}catch(_){return false}}))f.push(n)});
try{if(d.querySelectorAll('canvas').length)f.push('canvas×'+d.querySelectorAll('canvas').length)}catch(_){}
return f.join(', ')||'없음'}
function dump(w,p){var d;try{d=w.document}catch(_){L.push('['+p+'] 교차출처 접근불가');return}
if(!d||!d.body){L.push('['+p+'] 문서없음');return}
L.push('=== ['+p+'] '+c(d.title)+' | '+c(d.location.href));
L.push('    프레임워크: '+fw(w,d)+' | iframe '+d.querySelectorAll('iframe,frame').length);
var n=0;d.querySelectorAll('input,select,textarea').forEach(function(e){
if(e.type==='hidden'||n++>120)return;
L.push('  IN  '+e.tagName.toLowerCase()+'/'+(e.type||'')+' id='+(e.id||'-')+' name='+(e.name||'-')
+(e.readOnly?' [읽기전용]':'')+(vis(e)?'':' [숨김]')+' 라벨='+lab(e))});
n=0;d.querySelectorAll('button,input[type=button],input[type=submit],a[onclick],[role=button],[class*=btn]').forEach(function(e){
if(n++>120)return;var t=c(e.tagName==='INPUT'?e.value:e.textContent)||c(e.title);if(!t)return;
L.push('  BTN id='+(e.id||'-')+' name='+(e.name||'-')+(vis(e)?'':' [숨김]')+' 글자="'+t+'"')});
n=0;d.querySelectorAll('[role=tab],[class*=tab] li,[class*=tab] a,[id*=tab]').forEach(function(e){
if(n++>40)return;var t=c(e.textContent);if(!t||t.length>30)return;
L.push('  TAB id='+(e.id||'-')+' 글자="'+t+'"')});
for(var i=0;i<w.frames.length;i++){var nm='';try{nm=w.frames[i].frameElement&&(w.frames[i].frameElement.id||w.frames[i].frameElement.name)||''}catch(_){}
dump(w.frames[i],p+'>'+i+(nm?':'+nm:''))}}
dump(window,'top');var out=location.href+'\n'+L.join('\n');window.__D=out;
console.log(out);console.log('%c위 내용을 복사하려면:  copy(__D)','color:#06c;font-weight:bold');return'완료 — copy(__D) 실행하세요'})();
