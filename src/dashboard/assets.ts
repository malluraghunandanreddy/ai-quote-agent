/**
 * The dashboard's only script. Everything works without it (it is served from the dashboard's own address, so the
 * content-security policy allows it, and it never touches the network). It adds three things: hover/keyboard
 * tooltips on the charts, numbers that count up once on load, and nothing else. It only ever sets textContent.
 */
export const APP_JS = `(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  function place(x, y) {
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
    var top = y - h - 14;
    if (top < 8) top = y + 20;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function show(el, x, y) {
    var text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('on');
    place(x, y);
  }
  function hide() { tip.classList.remove('on'); }

  document.addEventListener('pointermove', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el) show(el, e.clientX, e.clientY); else hide();
  });
  document.addEventListener('pointerleave', hide);
  document.addEventListener('focusin', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) return;
    var r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', hide);

  if (!reduce) {
    var nodes = document.querySelectorAll('[data-count]');
    Array.prototype.forEach.call(nodes, function (el) {
      var target = parseInt(el.getAttribute('data-count'), 10);
      var finalText = el.textContent;
      if (!isFinite(target) || target <= 0) return;
      var start = null;
      el.textContent = '0';
      // Animation frames pause in a background tab; make sure the real number always ends up on screen.
      window.setTimeout(function () { el.textContent = finalText; }, 1400);
      function step(ts) {
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / 800);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = p < 1 ? String(Math.round(target * eased)) : finalText;
        if (p < 1) window.requestAnimationFrame(step);
      }
      window.requestAnimationFrame(step);
    });
  }
})();
`;
