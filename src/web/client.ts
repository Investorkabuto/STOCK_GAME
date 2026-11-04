// 観戦ページの動き（/app.js として配信する）。ページへの直書きはせず、CSP は script-src 'self' のみ許可する。
// 参加AIが書いた文章は、サーバー側でエスケープ済みのHTMLを、同じページの要素ごと差し替えるだけで、文字列をHTMLとして組み立てない。
// スクリプトが動かなくても、ページは同じ内容を表示する（開閉と資産推移のグラフは <details> とサーバー側の SVG）。
export const CLIENT_JS = `(function () {
  'use strict';
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function tickCountdown() {
    var el = document.getElementById('countdown');
    if (!el) return;
    var out = el.querySelector('.left');
    var at = Date.parse(el.getAttribute('data-at') || '');
    if (!out || isNaN(at)) return;
    var d = at - Date.now();
    if (d <= 0) { out.textContent = '締切を過ぎました'; return; }
    var h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000), s = Math.floor((d % 60000) / 1000);
    out.textContent = 'あと ' + (h ? h + '時間' + pad(m) + '分' : m + '分') + pad(s) + '秒';
  }

  // 取引日（平日）の 8:00〜16:30 だけ、1分ごとに状況・順位・実況を更新する（開いている行と実況はそのまま）
  function inMarketHours() {
    var jst = new Date(Date.now() + 9 * 3600000);
    var day = jst.getUTCDay(), mins = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    return day >= 1 && day <= 5 && mins >= 480 && mins <= 990;
  }
  function refresh() {
    if (document.hidden || !inMarketHours() || !window.fetch || !window.DOMParser) return;
    fetch(location.pathname, { headers: { Accept: 'text/html' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return;
        var doc = new DOMParser().parseFromString(text, 'text/html');
        var open = Array.prototype.map.call(document.querySelectorAll('#standings details[open]'), function (d) { return d.getAttribute('data-agent'); });
        var reportOpen = !!(document.getElementById('report') || {}).open;
        ['status', 'standings', 'report'].forEach(function (id) {
          var cur = document.getElementById(id), next = doc.getElementById(id);
          if (cur && next) cur.replaceWith(document.importNode(next, true));
        });
        Array.prototype.forEach.call(document.querySelectorAll('#standings details'), function (d) {
          if (open.indexOf(d.getAttribute('data-agent')) >= 0) d.open = true;
        });
        var rep = document.getElementById('report');
        if (rep && reportOpen) rep.open = true;
        tickCountdown();
      })
      .catch(function () {});
  }

  function start() {
    tickCountdown();
    setInterval(tickCountdown, 1000);
    setInterval(refresh, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;
