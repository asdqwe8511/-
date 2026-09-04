// 캔버스 봉차트. 외부 라이브러리 없이 그린다.
//
//   const chart = new TradingChart(containerEl, { onHover, onLayout });
//   chart.setData(bars);        // [{date, open, high, low, close, volume}]
//   chart.setStudy(study);      // TradingEngine.buildStudy(...) 결과
//
// 마우스 휠·드래그, 두 손가락 벌리기로 확대·이동. 더블클릭(더블탭)은 전체 보기.
// 한국식 색: 오른 봉 빨강, 내린 봉 파랑.
(function (root) {
  'use strict';

  const COLORS = {
    up: '#ff5470', down: '#4c8dff', text: '#9298a8', textStrong: '#f2f3f5',
    grid: 'rgba(255,255,255,0.06)', axis: 'rgba(255,255,255,0.12)', cross: 'rgba(242,243,245,0.45)',
    buy: '#2dd4bf', sell: '#ffb347', note: '#c084fc', labelBg: '#2a2d38'
  };
  const AXIS_W = 70, AXIS_H = 24, PANE_GAP = 6, MIN_BARS = 8;

  function fmtPrice(v, ref) {
    if (v == null || !isFinite(v)) return '-';
    const r = Math.abs(ref == null ? v : ref);
    if (r >= 1000) return Math.round(v).toLocaleString('ko-KR');
    if (r >= 100) return v.toFixed(1);
    if (r >= 1) return v.toFixed(2);
    return v.toFixed(4);
  }
  function fmtVolume(v) {
    if (v == null || !isFinite(v)) return '-';
    const a = Math.abs(v), sign = v < 0 ? '-' : '';
    if (a >= 1e8) return sign + (a / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '억';
    if (a >= 1e4) return sign + (a / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '만';
    return sign + Math.round(a).toLocaleString('ko-KR');
  }
  function fmtCompact(v, ref) {
    // 지표 패널용: 큰 값은 만/억, 작은 값은 소수.
    if (v == null || !isFinite(v)) return '-';
    if (Math.abs(ref == null ? v : ref) >= 1e5) return fmtVolume(v);
    return fmtPrice(v, ref);
  }

  function niceStep(range, target) {
    const rough = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(rough)));
    const m = rough / p;
    const nice = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
    return nice * p;
  }

  function TradingChart(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.bars = [];
    this.study = { overlays: [], panels: [], markers: [], extra: 3 };
    this.first = 0; this.count = 120;
    this.hover = null;                 // {index, pane, y}
    this.panes = [];
    this.width = 0; this.height = 0;

    const canvas = document.createElement('canvas');
    canvas.className = 'tc-canvas';
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this._bind();
    const self = this;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(container);
    } else {
      window.addEventListener('resize', function () { self.resize(); });
    }
    this.resize();
  }

  const P = TradingChart.prototype;

  P.resize = function () {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(50, Math.floor(rect.width)), h = Math.max(50, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.width = w; this.height = h;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  };

  P.setData = function (bars, keepView) {
    this.bars = bars || [];
    if (!keepView) this.fit();
    else this._clampView();
    this.hover = null;
    this.render();
  };

  P.setStudy = function (study) {
    this.study = study || { overlays: [], panels: [], markers: [], extra: 0 };
    this._clampView();
    this.render();
  };

  P.total = function () { return this.bars.length + Math.max(3, this.study.extra || 0); };

  P.fit = function () {
    const n = this.bars.length;
    this.count = Math.max(MIN_BARS, Math.min(n + 3, 160));
    this.first = Math.max(0, n + 3 - this.count);
    this._clampView();
    this.render();
  };

  P.showAll = function () {
    this.count = Math.max(MIN_BARS, this.total());
    this.first = 0;
    this.render();
  };

  P._clampView = function () {
    const total = this.total();
    this.count = Math.max(MIN_BARS, Math.min(this.count, Math.max(MIN_BARS, total)));
    this.first = Math.max(0, Math.min(this.first, total - this.count));
  };

  P.zoom = function (factor, anchorRatio) {
    if (anchorRatio == null) anchorRatio = 0.5;
    const anchorIdx = this.first + this.count * anchorRatio;
    this.count = this.count * factor;
    this.first = anchorIdx - this.count * anchorRatio;
    this._clampView();
    this.render();
  };

  P.panBars = function (deltaBars) {
    this.first += deltaBars;
    this._clampView();
    this.render();
  };

  // 특정 봉이 가운데 오도록 이동하고 십자선을 거기에 둔다.
  P.goTo = function (index) {
    if (index < 0 || index >= this.bars.length) return;
    this.first = index - this.count / 2;
    this._clampView();
    this.hover = { index: index, pane: 0, y: null };
    this.render();
    this._emitHover();
  };

  // ── 좌표 ──
  P._plotW = function () { return Math.max(10, this.width - AXIS_W); };
  P._barW = function () { return this._plotW() / this.count; };
  P._xOf = function (i) { return (i - this.first + 0.5) * this._barW(); };
  P._indexAt = function (x) { return Math.floor(this.first + x / this._barW()); };

  P._visibleRange = function () {
    const i0 = Math.max(0, Math.floor(this.first));
    const i1 = Math.min(this.bars.length - 1, Math.ceil(this.first + this.count));
    return [i0, i1];
  };

  P._layout = function () {
    const panels = this.study.panels || [];
    const weights = [3].concat(panels.map(function (p) { return p.height || 1; }));
    const sum = weights.reduce(function (a, b) { return a + b; }, 0);
    const avail = this.height - AXIS_H - PANE_GAP * panels.length;
    const panes = [];
    let top = 0;
    weights.forEach(function (w, i) {
      const h = Math.floor(avail * w / sum);
      panes.push({ id: i === 0 ? 'main' : panels[i - 1].id, name: i === 0 ? null : panels[i - 1].name, top: top, height: h, panel: i === 0 ? null : panels[i - 1] });
      top += h + PANE_GAP;
    });
    this.panes = panes;
    return panes;
  };

  P.getPanes = function () { return this.panes; };

  function seriesRange(values, i0, i1, acc) {
    if (!values) return;
    const end = Math.min(values.length - 1, i1);
    for (let i = i0; i <= end; i++) {
      const v = values[i];
      if (v == null || !isFinite(v)) continue;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
    }
  }

  P._mainRange = function (i0, i1) {
    const acc = { min: Infinity, max: -Infinity };
    for (let i = i0; i <= i1; i++) { const b = this.bars[i]; if (b.low < acc.min) acc.min = b.low; if (b.high > acc.max) acc.max = b.high; }
    const priceMin = acc.min, priceMax = acc.max;
    const iEnd = Math.ceil(this.first + this.count);
    (this.study.overlays || []).forEach(function (o) {
      if (o.kind === 'line' || o.kind === 'dots' || o.kind === 'step') seriesRange(o.values, i0, iEnd, acc);
      else if (o.kind === 'band') { seriesRange(o.upper, i0, iEnd, acc); seriesRange(o.lower, i0, iEnd, acc); }
      else if (o.kind === 'cloud') { seriesRange(o.a, i0, iEnd, acc); seriesRange(o.b, i0, iEnd, acc); }
      else if (o.kind === 'levels') {
        (o.levels || []).forEach(function (l) {
          if (l.price >= priceMin * 0.85 && l.price <= priceMax * 1.15) { acc.min = Math.min(acc.min, l.price); acc.max = Math.max(acc.max, l.price); }
        });
      }
    });
    if (!isFinite(acc.min)) { acc.min = 0; acc.max = 1; }
    const pad = (acc.max - acc.min) * 0.07 || acc.max * 0.05 || 1;
    return { min: acc.min - pad, max: acc.max + pad };
  };

  P._panelRange = function (panel, i0, i1) {
    if (panel.range) return { min: panel.range[0], max: panel.range[1] };
    const acc = { min: Infinity, max: -Infinity };
    const iEnd = Math.ceil(this.first + this.count);
    panel.series.forEach(function (s) { seriesRange(s.values, i0, iEnd, acc); });
    if (panel.zero || panel.series.some(function (s) { return s.kind === 'hist'; })) { acc.min = Math.min(acc.min, 0); acc.max = Math.max(acc.max, 0); }
    if (!isFinite(acc.min)) { acc.min = 0; acc.max = 1; }
    if (acc.max === acc.min) { acc.max += 1; acc.min -= 1; }
    const pad = (acc.max - acc.min) * 0.1;
    return { min: acc.min - (acc.min === 0 && !panel.zero ? 0 : pad), max: acc.max + pad };
  };

  // ── 그리기 ──
  P.render = function () {
    const ctx = this.ctx, W = this.width, H = this.height;
    ctx.clearRect(0, 0, W, H);
    const panes = this._layout();
    if (this.opts.onLayout) this.opts.onLayout(panes);
    if (!this.bars.length) {
      ctx.fillStyle = COLORS.text; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('데이터를 불러오면 여기에 차트가 그려집니다.', W / 2, H / 2);
      return;
    }
    const range = this._visibleRange();
    const i0 = range[0], i1 = range[1];
    const plotW = this._plotW();

    const self = this;
    panes.forEach(function (pane, pi) {
      const yr = pi === 0 ? self._mainRange(i0, i1) : self._panelRange(pane.panel, i0, i1);
      pane.min = yr.min; pane.max = yr.max;
      pane.y = function (v) { return pane.top + (yr.max - v) / (yr.max - yr.min) * pane.height; };
      pane.v = function (y) { return yr.max - (y - pane.top) / pane.height * (yr.max - yr.min); };

      ctx.save();
      ctx.beginPath(); ctx.rect(0, pane.top, W, pane.height); ctx.clip();
      self._drawGrid(pane, pi === 0 ? 'price' : (pane.panel.series.some(function (s) { return s.kind === 'hist' && s.colorBy === 'candle'; }) ? 'volume' : 'value'));
      if (pi === 0) self._drawMain(pane, i0, i1);
      else self._drawPanel(pane, i0, i1);
      ctx.restore();

      // 패널 구분선
      if (pi > 0) {
        ctx.strokeStyle = COLORS.axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, pane.top - PANE_GAP / 2 + 0.5); ctx.lineTo(W, pane.top - PANE_GAP / 2 + 0.5); ctx.stroke();
      }
    });

    // 축 배경(오른쪽 세로줄)
    ctx.strokeStyle = COLORS.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, H - AXIS_H); ctx.stroke();
    this._drawTimeAxis(panes, i0, i1);
    this._drawCrosshair(panes);
  };

  P._drawGrid = function (pane, mode) {
    const ctx = this.ctx, plotW = this._plotW();
    const span = pane.max - pane.min;
    const step = niceStep(span, Math.max(2, Math.floor(pane.height / 38)));
    const start = Math.ceil(pane.min / step) * step;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let v = start; v <= pane.max; v += step) {
      const y = Math.round(pane.y(v)) + 0.5;
      if (y < pane.top + 6 || y > pane.top + pane.height - 6) continue;
      ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      const label = mode === 'volume' ? fmtVolume(v) : mode === 'value' ? fmtCompact(v, span) : fmtPrice(v, pane.max);
      ctx.fillText(label, plotW + 6, y);
    }
  };

  P._drawLine = function (pane, values, color, width, dash, step) {
    if (!values) return;
    const ctx = this.ctx;
    const iStart = Math.max(0, Math.floor(this.first) - 1), iEnd = Math.min(values.length - 1, Math.ceil(this.first + this.count) + 1);
    ctx.strokeStyle = color; ctx.lineWidth = width || 1; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false, prevY = null;
    const barW = this._barW();
    for (let i = iStart; i <= iEnd; i++) {
      const v = values[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      const x = this._xOf(i), y = pane.y(v);
      if (!pen) { ctx.moveTo(step ? x - barW / 2 : x, y); pen = true; }
      else if (step) { ctx.lineTo(x - barW / 2, prevY); ctx.lineTo(x - barW / 2, y); }
      else ctx.lineTo(x, y);
      if (step) ctx.lineTo(x + barW / 2, y);
      prevY = y;
    }
    ctx.stroke(); ctx.setLineDash([]);
  };

  P._drawFill = function (pane, upper, lower, color, splitColor) {
    // upper/lower 사이를 칠한다. splitColor 가 있으면 upper<lower 구간을 다른 색으로.
    const ctx = this.ctx;
    const iStart = Math.max(0, Math.floor(this.first) - 1), iEnd = Math.min(Math.min(upper.length, lower.length) - 1, Math.ceil(this.first + this.count) + 1);
    let segStart = -1, segSign = 0;
    const flush = (end) => {
      if (segStart < 0) return;
      ctx.fillStyle = segSign >= 0 || !splitColor ? color : splitColor;
      ctx.beginPath();
      for (let i = segStart; i <= end; i++) { const x = this._xOf(i), y = pane.y(upper[i]); if (i === segStart) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      for (let i = end; i >= segStart; i--) ctx.lineTo(this._xOf(i), pane.y(lower[i]));
      ctx.closePath(); ctx.fill();
      segStart = -1;
    };
    for (let i = iStart; i <= iEnd; i++) {
      const u = upper[i], l = lower[i];
      if (u == null || l == null) { flush(i - 1); continue; }
      const sign = splitColor ? (u >= l ? 1 : -1) : 1;
      if (segStart < 0) { segStart = i; segSign = sign; }
      else if (sign !== segSign) { flush(i); segStart = i; segSign = sign; }
    }
    flush(iEnd);
  };

  P._drawMain = function (pane, i0, i1) {
    const ctx = this.ctx, self = this;
    const barW = this._barW();
    const ov = this.study.overlays || [];

    ov.forEach(function (o) {
      if (o.kind === 'cloud') self._drawFill(pane, o.a, o.b, o.colorUp, o.colorDown);
      else if (o.kind === 'band') {
        const fill = o.color.replace(/^#(..)(..)(..)$/, function (_, r, g, b) { return 'rgba(' + parseInt(r, 16) + ',' + parseInt(g, 16) + ',' + parseInt(b, 16) + ',0.08)'; });
        self._drawFill(pane, o.upper, o.lower, fill);
      }
    });
    ov.forEach(function (o) {
      if (o.kind === 'band') {
        self._drawLine(pane, o.upper, o.color, 1); self._drawLine(pane, o.lower, o.color, 1);
        if (o.middle) self._drawLine(pane, o.middle, o.color, 1, [3, 3]);
      } else if (o.kind === 'step') self._drawLine(pane, o.values, o.color, 1, o.dash, true);
    });
    ov.forEach(function (o) { if (o.kind === 'line') self._drawLine(pane, o.values, o.color, o.width || 1, o.dash); });

    // 봉
    const bodyW = Math.max(1, Math.min(barW * 0.72, 24));
    for (let i = i0; i <= i1; i++) {
      const b = this.bars[i];
      const x = this._xOf(i);
      const up = b.close >= b.open;
      const color = up ? COLORS.up : COLORS.down;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      const yH = pane.y(b.high), yL = pane.y(b.low), yO = pane.y(b.open), yC = pane.y(b.close);
      const xr = Math.round(x) + 0.5;
      ctx.beginPath(); ctx.moveTo(xr, yH); ctx.lineTo(xr, yL); ctx.stroke();
      const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yO - yC));
      if (bodyW <= 2) { ctx.fillRect(xr - 0.5, top, 1, h); }
      else if (up) { ctx.fillRect(x - bodyW / 2, top, bodyW, h); }
      else { ctx.fillRect(x - bodyW / 2, top, bodyW, h); }
    }

    ov.forEach(function (o) {
      if (o.kind === 'dots') {
        ctx.fillStyle = o.color;
        const iEnd = Math.min(o.values.length - 1, Math.ceil(self.first + self.count) + 1);
        const r = Math.max(1, Math.min(2.5, barW * 0.18));
        for (let i = Math.max(0, Math.floor(self.first)); i <= iEnd; i++) {
          const v = o.values[i]; if (v == null) continue;
          ctx.beginPath(); ctx.arc(self._xOf(i), pane.y(v), r, 0, Math.PI * 2); ctx.fill();
        }
      } else if (o.kind === 'levels') {
        ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        (o.levels || []).forEach(function (l) {
          const y = Math.round(pane.y(l.price)) + 0.5;
          if (y < pane.top || y > pane.top + pane.height) return;
          const x0 = l.from != null ? Math.max(0, self._xOf(l.from)) : 0;
          ctx.strokeStyle = l.color; ctx.setLineDash(l.dash || []); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(self._plotW(), y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = l.color; ctx.fillText(l.label + '  ' + fmtPrice(l.price, l.price), self._plotW() - 4, y - 2);
        });
      }
    });

    this._drawMarkers(pane, i0, i1);
  };

  P._drawMarkers = function (pane, i0, i1) {
    const ctx = this.ctx, barW = this._barW();
    const markers = this.study.markers || [];
    const size = Math.max(4, Math.min(7, barW * 0.45));
    const stackAbove = {}, stackBelow = {};
    const showText = barW >= 28;
    ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    markers.forEach((m) => {
      if (m.index < i0 || m.index > i1) return;
      const b = this.bars[m.index];
      const x = this._xOf(m.index);
      const above = m.type === 'sell' || (m.type === 'note' && m.place === 'above');
      const stack = above ? stackAbove : stackBelow;
      const n = stack[m.index] || 0; stack[m.index] = n + 1;
      const offset = 6 + n * (size * 2 + 3);
      const color = m.color || (m.type === 'buy' ? COLORS.buy : m.type === 'sell' ? COLORS.sell : COLORS.note);
      ctx.fillStyle = color;
      ctx.beginPath();
      if (above) {
        const y = pane.y(b.high) - offset;
        if (m.type === 'note') { ctx.arc(x, y - size / 2, size * 0.6, 0, Math.PI * 2); }
        else { ctx.moveTo(x, y); ctx.lineTo(x - size, y - size * 1.6); ctx.lineTo(x + size, y - size * 1.6); ctx.closePath(); }
        ctx.fill();
        if (showText) { ctx.textBaseline = 'bottom'; ctx.fillText(m.text, x, y - size * 1.8); }
      } else {
        const y = pane.y(b.low) + offset;
        if (m.type === 'note') { ctx.arc(x, y + size / 2, size * 0.6, 0, Math.PI * 2); }
        else { ctx.moveTo(x, y); ctx.lineTo(x - size, y + size * 1.6); ctx.lineTo(x + size, y + size * 1.6); ctx.closePath(); }
        ctx.fill();
        if (showText) { ctx.textBaseline = 'top'; ctx.fillText(m.text, x, y + size * 1.8); }
      }
    });
  };

  P._drawPanel = function (pane, i0, i1) {
    const ctx = this.ctx, self = this, panel = pane.panel, barW = this._barW();
    (panel.guides || []).forEach(function (g) {
      const y = Math.round(pane.y(g.value)) + 0.5;
      ctx.strokeStyle = g.color; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(self._plotW(), y); ctx.stroke(); ctx.setLineDash([]);
    });
    const y0 = pane.y(Math.max(pane.min, Math.min(pane.max, 0)));
    const bodyW = Math.max(1, Math.min(barW * 0.72, 24));
    panel.series.forEach(function (s) {
      if (s.kind !== 'hist') return;
      for (let i = i0; i <= i1; i++) {
        const v = s.values[i]; if (v == null) continue;
        const b = self.bars[i];
        let color = s.color || COLORS.text;
        if (s.colorBy === 'candle') color = b.close >= b.open ? COLORS.up : COLORS.down;
        else if (s.colorBy === 'sign') color = v >= 0 ? COLORS.up : COLORS.down;
        ctx.fillStyle = color;
        if (s.colorBy) ctx.globalAlpha = 0.8;
        const x = self._xOf(i), y = pane.y(v);
        ctx.fillRect(x - bodyW / 2, Math.min(y, y0), bodyW, Math.max(1, Math.abs(y - y0)));
        ctx.globalAlpha = 1;
      }
    });
    panel.series.forEach(function (s) { if (s.kind === 'line') self._drawLine(pane, s.values, s.color, s.width || 1, s.dash); });
  };

  P._drawTimeAxis = function (panes, i0, i1) {
    const ctx = this.ctx, barW = this._barW(), yBase = this.height - AXIS_H;
    const plotW = this._plotW();
    ctx.strokeStyle = COLORS.axis; ctx.beginPath(); ctx.moveTo(0, yBase + 0.5); ctx.lineTo(plotW, yBase + 0.5); ctx.stroke();
    ctx.fillStyle = COLORS.text; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const minPx = 72;
    const stepBars = Math.max(1, Math.ceil(minPx / barW));
    let lastX = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const d = this.bars[i].date, prev = i > 0 ? this.bars[i - 1].date : null;
      const monthChange = !prev || d.slice(0, 7) !== prev.slice(0, 7);
      const yearChange = !prev || d.slice(0, 4) !== prev.slice(0, 4);
      let label = null;
      if (stepBars >= 12) {
        if (monthChange) label = yearChange ? d.slice(0, 4) + '.' + d.slice(5, 7) : d.slice(5, 7) + '월';
      } else if (monthChange) label = d.slice(2, 4) + '.' + d.slice(5, 7);
      else if ((i - i0) % stepBars === 0) label = d.slice(5, 7) + '.' + d.slice(8, 10);
      if (!label) continue;
      const x = this._xOf(i);
      if (x - lastX < minPx * 0.8) continue;
      lastX = x;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, yBase); ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(label, x, yBase + 6);
    }
  };

  P._drawCrosshair = function (panes) {
    const h = this.hover;
    if (!h || h.index == null || h.index < 0 || h.index >= this.bars.length) return;
    const ctx = this.ctx, x = Math.round(this._xOf(h.index)) + 0.5, plotW = this._plotW();
    ctx.strokeStyle = COLORS.cross; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.height - AXIS_H); ctx.stroke();
    const pane = panes[h.pane] || panes[0];
    let yLine = h.y;
    if (yLine == null) yLine = pane.y(this.bars[h.index].close);
    if (yLine >= pane.top && yLine <= pane.top + pane.height) {
      ctx.beginPath(); ctx.moveTo(0, Math.round(yLine) + 0.5); ctx.lineTo(plotW, Math.round(yLine) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      const v = pane.v(yLine);
      const label = h.pane === 0 ? fmtPrice(v, pane.max) : (pane.panel && pane.panel.series.some(function (s) { return s.colorBy === 'candle'; }) ? fmtVolume(v) : fmtCompact(v, pane.max - pane.min));
      ctx.font = '11px sans-serif';
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = COLORS.labelBg; ctx.fillRect(plotW + 1, yLine - 9, Math.max(w, AXIS_W - 2), 18);
      ctx.fillStyle = COLORS.textStrong; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, plotW + 6, yLine);
    }
    ctx.setLineDash([]);
    const d = this.bars[h.index].date;
    ctx.font = '11px sans-serif';
    const dw = ctx.measureText(d).width + 12;
    const dx = Math.min(Math.max(0, x - dw / 2), plotW - dw);
    ctx.fillStyle = COLORS.labelBg; ctx.fillRect(dx, this.height - AXIS_H + 2, dw, AXIS_H - 4);
    ctx.fillStyle = COLORS.textStrong; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(d, dx + dw / 2, this.height - AXIS_H / 2);
  };

  // 호버 위치의 값 묶음. 화면의 범례가 쓴다.
  P.valuesAt = function (index) {
    if (index == null || index < 0 || index >= this.bars.length) index = this.bars.length - 1;
    if (index < 0) return null;
    const bar = this.bars[index], prev = index > 0 ? this.bars[index - 1] : null;
    const overlays = [];
    (this.study.overlays || []).forEach(function (o) {
      if (o.kind === 'line' || o.kind === 'dots' || o.kind === 'step') overlays.push({ name: o.name, color: o.color, value: o.values[index], ref: bar.close });
      else if (o.kind === 'band') {
        overlays.push({ name: o.name + ' 상', color: o.color, value: o.upper[index], ref: bar.close });
        if (o.middle) overlays.push({ name: o.name + ' 중', color: o.color, value: o.middle[index], ref: bar.close });
        overlays.push({ name: o.name + ' 하', color: o.color, value: o.lower[index], ref: bar.close });
      } else if (o.kind === 'cloud') {
        overlays.push({ name: '선행A', color: '#2dd4bf', value: o.a[index], ref: bar.close });
        overlays.push({ name: '선행B', color: '#ff5470', value: o.b[index], ref: bar.close });
      }
    });
    const panels = (this.study.panels || []).map(function (p) {
      return {
        id: p.id, name: p.name,
        series: p.series.map(function (s) {
          const v = s.values[index];
          return { name: s.name, color: s.colorBy ? (s.colorBy === 'candle' ? (bar.close >= bar.open ? COLORS.up : COLORS.down) : (v >= 0 ? COLORS.up : COLORS.down)) : s.color, value: v, isVolume: s.colorBy === 'candle' };
        })
      };
    });
    const markers = (this.study.markers || []).filter(function (m) { return m.index === index; });
    return { index: index, bar: bar, prev: prev, overlays: overlays, panels: panels, markers: markers };
  };

  P._emitHover = function () {
    if (this.opts.onHover) this.opts.onHover(this.hover ? this.hover.index : null);
  };

  // ── 입력 ──
  P._bind = function () {
    const c = this.canvas, self = this;
    let drag = null, moved = false;
    let touchStart = null, lastTap = 0;

    const pos = function (e) {
      const r = c.getBoundingClientRect();
      const pt = e.touches ? e.touches[0] : e;
      return { x: pt.clientX - r.left, y: pt.clientY - r.top };
    };
    const paneAt = function (y) {
      for (let i = 0; i < self.panes.length; i++) { const p = self.panes[i]; if (y >= p.top && y <= p.top + p.height) return i; }
      return 0;
    };
    const setHover = function (p) {
      if (!self.bars.length) return;
      if (p.x < 0 || p.x > self._plotW()) { self.hover = null; }
      else {
        const idx = self._indexAt(p.x);
        self.hover = { index: Math.max(0, Math.min(self.bars.length - 1, idx)), pane: paneAt(p.y), y: p.y };
      }
      self.render(); self._emitHover();
    };

    c.addEventListener('mousemove', function (e) {
      const p = pos(e);
      if (drag) {
        const dx = p.x - drag.x;
        if (Math.abs(dx) > 2) moved = true;
        self.first = drag.first - dx / self._barW();
        self._clampView();
        self.hover = null; self.render();
        return;
      }
      setHover(p);
    });
    c.addEventListener('mouseleave', function () { if (!drag) { self.hover = null; self.render(); self._emitHover(); } });
    c.addEventListener('mousedown', function (e) { const p = pos(e); drag = { x: p.x, first: self.first }; moved = false; c.style.cursor = 'grabbing'; e.preventDefault(); });
    window.addEventListener('mouseup', function (e) {
      if (!drag) return;
      drag = null; c.style.cursor = '';
      if (!moved) setHover(pos(e));
    });
    c.addEventListener('dblclick', function () { self.fit(); });
    c.addEventListener('wheel', function (e) {
      if (!self.bars.length) return;
      e.preventDefault();
      const p = pos(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { self.panBars(e.deltaX / self._barW()); return; }
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      self.zoom(factor, Math.max(0, Math.min(1, p.x / self._plotW())));
      setHover(p);
    }, { passive: false });

    const dist = function (t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); };
    c.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        const p = pos(e);
        touchStart = { x: p.x, y: p.y, first: self.first, moved: false, t: Date.now() };
      } else if (e.touches.length === 2) {
        const r = c.getBoundingClientRect();
        touchStart = { pinch: true, d: dist(e.touches), count: self.count, first: self.first, mid: ((e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left) };
      }
      e.preventDefault();
    }, { passive: false });
    c.addEventListener('touchmove', function (e) {
      if (!touchStart) return;
      e.preventDefault();
      if (touchStart.pinch && e.touches.length === 2) {
        const ratio = touchStart.d / Math.max(1, dist(e.touches));
        const anchorIdx = touchStart.first + touchStart.count * (touchStart.mid / self._plotW());
        self.count = touchStart.count * ratio;
        self.first = anchorIdx - self.count * (touchStart.mid / self._plotW());
        self._clampView(); self.render();
        return;
      }
      if (e.touches.length === 1 && !touchStart.pinch) {
        const p = pos(e);
        const dx = p.x - touchStart.x;
        if (Math.abs(dx) > 4) touchStart.moved = true;
        if (touchStart.moved) { self.first = touchStart.first - dx / self._barW(); self._clampView(); self.hover = null; self.render(); }
      }
    }, { passive: false });
    c.addEventListener('touchend', function (e) {
      if (!touchStart) return;
      if (!touchStart.pinch && !touchStart.moved) {
        const now = Date.now();
        if (now - lastTap < 300) { self.fit(); lastTap = 0; }
        else { lastTap = now; setHover({ x: touchStart.x, y: touchStart.y }); }
      }
      if (e.touches.length === 0) touchStart = null;
      e.preventDefault();
    }, { passive: false });
  };

  TradingChart.fmtPrice = fmtPrice;
  TradingChart.fmtVolume = fmtVolume;
  TradingChart.fmtCompact = fmtCompact;
  TradingChart.COLORS = COLORS;
  root.TradingChart = TradingChart;
}(typeof self !== 'undefined' ? self : this));
