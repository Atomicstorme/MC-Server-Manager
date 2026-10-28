// Minimal canvas line chart for the monitoring graphs (no dependencies).
// drawChart(canvas, points, { max, color, format }) where points = [{t, v}].
window.drawChart = function drawChart(canvas, points, { max, min = 0, color = '#5cc46b', format = (v) => v.toFixed(0), windowMs = 15 * 60 * 1000 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 40, r: 8, t: 8, b: 18 };
  const now = Date.now();
  const t0 = now - windowMs;
  const pts = points.filter((p) => p.t >= t0 && p.v != null && Number.isFinite(p.v));
  const top = max ?? Math.max(1, ...pts.map((p) => p.v)) * 1.15;
  const x = (t) => pad.l + ((t - t0) / windowMs) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (top - min || 1)) * (h - pad.t - pad.b);

  ctx.font = '10px Segoe UI, sans-serif';
  ctx.fillStyle = '#7d8590';
  ctx.strokeStyle = '#2a2b30';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = min + ((top - min) * i) / 3;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(format(v), pad.l - 6, yy + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText(`-${Math.round(windowMs / 60000)}m`, pad.l, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText('now', w - pad.r, h - 4);

  if (pts.length < 2) {
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for data…', w / 2, h / 2);
    return;
  }
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineTo(x(pts[pts.length - 1].t), y(min));
  ctx.lineTo(x(pts[0].t), y(min));
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
};
