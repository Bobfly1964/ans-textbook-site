/* C06 pdf-composer (S0 PoC): builds a NEW PDF in the browser from build-time WeasyPrint unit fragments
   of ONE release. No LLM, no server. Checks every fragment's sha256 against fragments.json and the unit's
   bundle hash against the public manifest before merging (PDF-02, PDF-07). */
(function () {
  "use strict";
  var ANS = window.ANS || {};
  var root = ANS.release_root || "./";
  var L = null;
  var state = { frag: null, manifest: null, order: [] };
  var A4 = [595.28, 841.89];
  var M = { left: 62, right: 56, top: 64, bottom: 60 };

  function $(s, r) { return (r || document).querySelector(s); }
  function el(t, a, c) { var n = document.createElement(t); Object.keys(a || {}).forEach(function (k) { if (k === "text") n.textContent = a[k]; else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), a[k]); else n.setAttribute(k, a[k]); }); (c || []).forEach(function (x) { if (x) n.appendChild(typeof x === "string" ? document.createTextNode(x) : x); }); return n; }
  function log(t) { var b = $("#ans-pdf-log"); b.textContent += t + "\n"; b.scrollTop = b.scrollHeight; }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function sha256(buf) { return crypto.subtle.digest("SHA-256", buf).then(hex); }
  function fetchBuf(u) { return fetch(u, { credentials: "omit", cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " для " + u); return r.arrayBuffer(); }); }
  function getSel() { try { return JSON.parse(localStorage.getItem("ans:" + ANS.release_id + ":pdf-selection") || "[]"); } catch (e) { return []; } }
  function putSel(a) { try { localStorage.setItem("ans:" + ANS.release_id + ":pdf-selection", JSON.stringify(a)); } catch (e) {} }

  var units = {}; // unit_id -> fragment record
  function render() {
    var box = $("#ans-pdf-tree"); box.innerHTML = "";
    var ul = el("ul", { class: "ans-tree" });
    state.frag.lessons.forEach(function (les) {
      var lid = les.lesson_id;
      var all = el("input", { type: "checkbox", id: "chk-" + lid, "data-lesson": lid });
      var inner = el("ul");
      les.units.forEach(function (u) {
        units[u.unit_id] = Object.assign({ lesson_id: lid, lesson_title: les.title }, u);
        var cb = el("input", { type: "checkbox", id: "chk-" + u.unit_id, value: u.unit_id });
        cb.checked = state.order.indexOf(u.unit_id) >= 0;
        cb.addEventListener("change", function () { toggle(u.unit_id, cb.checked); syncLesson(); });
        inner.appendChild(el("li", {}, [cb, " ", el("label", { for: "chk-" + u.unit_id }, [el("code", { text: u.unit_id }), " " + u.heading + " ", el("span", { class: "ans-pages", text: "(" + u.pages + " стр.)" })])]));
      });
      all.addEventListener("change", function () { les.units.forEach(function (u) { toggle(u.unit_id, all.checked); $("#chk-" + cssEsc(u.unit_id)).checked = all.checked; }); });
      ul.appendChild(el("li", {}, [all, " ", el("label", { for: "chk-" + lid }, [el("strong", { text: lid.replace("ANS.", "") + ". " + les.title })]), inner]));
    });
    box.appendChild(ul);
    function syncLesson() { state.frag.lessons.forEach(function (les) { var c = $("#chk-" + cssEsc(les.lesson_id)); var n = les.units.filter(function (u) { return state.order.indexOf(u.unit_id) >= 0; }).length; c.checked = n === les.units.length; c.indeterminate = n > 0 && n < les.units.length; }); }
    syncLesson(); renderOrder();
  }
  function cssEsc(s) { return s.replace(/\./g, "\\."); }
  function toggle(uid, on) { var i = state.order.indexOf(uid); if (on && i < 0) state.order.push(uid); if (!on && i >= 0) state.order.splice(i, 1); putSel(state.order); renderOrder(); }
  function renderOrder() {
    var ol = $("#ans-pdf-order"); ol.innerHTML = "";
    var pages = 0;
    state.order.forEach(function (uid, i) {
      var u = units[uid]; if (!u) return; pages += u.pages;
      ol.appendChild(el("li", {}, [el("span", {}, [el("code", { text: uid }), " " + u.heading]),
        el("button", { type: "button", class: "ans-btn", "aria-label": "Выше: " + uid, onclick: function () { move(i, -1); } }, ["↑"]),
        el("button", { type: "button", class: "ans-btn", "aria-label": "Ниже: " + uid, onclick: function () { move(i, 1); } }, ["↓"])]));
    });
    $("#ans-pdf-summary").textContent = state.order.length ? ("Выбрано разделов: " + state.order.length + ", ориентировочно " + (pages + 2) + " стр.") : "Ничего не выбрано.";
    $("#ans-pdf-build").disabled = !state.order.length;
  }
  function move(i, d) { var j = i + d; if (j < 0 || j >= state.order.length) return; var t = state.order[i]; state.order[i] = state.order[j]; state.order[j] = t; putSel(state.order); renderOrder(); }

  /* ---------- text with font fallback ---------- */
  function Fonts(reg, bold, fb) { this.reg = reg; this.bold = bold; this.fb = fb; this.setR = new Set(reg.getCharacterSet()); this.setF = new Set(fb.getCharacterSet()); }
  Fonts.prototype.runs = function (text, isBold) {
    var main = isBold ? this.bold : this.reg, out = [], cur = null;
    Array.from(text).forEach(function (ch) {
      var cp = ch.codePointAt(0), f;
      if (this.setR.has(cp)) f = main; else if (this.setF.has(cp)) f = this.fb; else { f = main; ch = "?"; }
      if (cur && cur.font === f) cur.text += ch; else { cur = { font: f, text: ch }; out.push(cur); }
    }, this);
    return out;
  };
  Fonts.prototype.width = function (text, size, isBold) { return this.runs(text, isBold).reduce(function (w, r) { return w + r.font.widthOfTextAtSize(r.text, size); }, 0); };
  Fonts.prototype.draw = function (page, text, x, y, size, isBold, color) {
    this.runs(text, isBold).forEach(function (r) { page.drawText(r.text, { x: x, y: y, size: size, font: r.font, color: color || L.rgb(0.1, 0.1, 0.12) }); x += r.font.widthOfTextAtSize(r.text, size); });
  };
  Fonts.prototype.wrap = function (text, size, maxW, isBold) {
    var words = text.split(/\s+/), lines = [], line = "";
    words.forEach(function (w) { var t = line ? line + " " + w : w; if (this.width(t, size, isBold) > maxW && line) { lines.push(line); line = w; } else line = t; }, this);
    if (line) lines.push(line); return lines;
  };

  function linkAnnot(doc, page, rect, targetPage) {
    var ctx = doc.context;
    var annot = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0],
      Dest: [targetPage.ref, L.PDFName.of("XYZ"), L.PDFNull, L.PDFNull, L.PDFNull] });
    var ref = ctx.register(annot);
    var annots = page.node.lookup(L.PDFName.of("Annots"));
    if (annots instanceof L.PDFArray) annots.push(ref); else page.node.set(L.PDFName.of("Annots"), ctx.obj([ref]));
  }
  function buildOutline(doc, items) { // items: [{title, page, children:[...]}]
    var ctx = doc.context, rootRef = ctx.nextRef();
    function make(list, parentRef) {
      var refs = list.map(function () { return ctx.nextRef(); });
      var total = 0;
      list.forEach(function (it, i) {
        var d = { Title: L.PDFHexString.fromText(it.title), Parent: parentRef, Dest: [it.page.ref, L.PDFName.of("XYZ"), L.PDFNull, L.PDFNull, L.PDFNull] };
        if (i > 0) d.Prev = refs[i - 1]; if (i < list.length - 1) d.Next = refs[i + 1];
        var count = 0;
        if (it.children && it.children.length) { var sub = make(it.children, refs[i]); d.First = sub.first; d.Last = sub.last; d.Count = sub.count; count = sub.count; }
        ctx.assign(refs[i], ctx.obj(d)); total += 1 + count;
      });
      return { first: refs[0], last: refs[refs.length - 1], count: total };
    }
    var top = make(items, rootRef);
    ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count }));
    doc.catalog.set(L.PDFName.of("Outlines"), rootRef);
    doc.catalog.set(L.PDFName.of("PageMode"), L.PDFName.of("UseOutlines"));
  }

  function build() {
    var btn = $("#ans-pdf-build"); btn.disabled = true; $("#ans-pdf-log").textContent = "";
    var prog = $("#ans-pdf-progress"); prog.value = 0; prog.max = state.order.length + 4;
    var opts = { title: $("#opt-title").checked, toc: $("#opt-toc").checked };
    var chosen = state.order.slice();
    var bufs = {};
    var mUnits = {};
    state.manifest.lessons.forEach(function (les) { les.student_units.concat(les.workbook_units).forEach(function (u) { mUnits[u.unit_id] = u; }); });
    log("Редакция " + state.frag.release_id + ", commit " + state.frag.source_commit_sha.slice(0, 12) + ", manifest " + state.frag.public_manifest_digest.slice(0, 16));
    // 1) integrity of every fragment BEFORE any assembly (PDF-07)
    var seq = Promise.resolve();
    chosen.forEach(function (uid) {
      seq = seq.then(function () {
        var u = units[uid];
        if (!u) throw new Error("Раздел " + uid + " не входит в редакцию " + state.frag.release_id);
        var mu = mUnits[uid];
        if (!mu || mu.bundle_revision_hash !== u.bundle_revision_hash) throw new Error("Хеш раздела " + uid + " не совпадает с manifest редакции — сборка прервана.");
        return fetchBuf(root + "pdf/" + u.file).then(function (b) {
          return sha256(b).then(function (h) {
            if (h !== u.sha256) throw new Error("Фрагмент " + uid + " повреждён или подменён (sha256 " + h.slice(0, 12) + " ≠ " + u.sha256.slice(0, 12) + ") — сборка прервана.");
            bufs[uid] = b; prog.value += 1; log("✓ " + uid + " — sha256 совпал (" + u.pages + " стр.)");
          });
        });
      });
    });
    seq.then(function () {
      return Promise.all([L.PDFDocument.create(), fetchBuf(root + "assets/ans/fonts/PTSans-Regular.ttf"), fetchBuf(root + "assets/ans/fonts/PTSans-Bold.ttf"), fetchBuf(root + "assets/ans/fonts/DejaVuSans-fallback.ttf")]);
    }).then(function (r) {
      var doc = r[0]; doc.registerFontkit(window.fontkit);
      return Promise.all([doc, doc.embedFont(r[1], { subset: true }), doc.embedFont(r[2], { subset: true }), doc.embedFont(r[3], { subset: true })]);
    }).then(function (r) {
      var doc = r[0], F = new Fonts(r[1], r[2], r[3]);
      var now = new Date();
      var stamp = now.toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
      var W = A4[0], H = A4[1], cw = W - M.left - M.right;
      var siteUrl = (ANS.public_base_url || "") + (ANS.release_root || "");
      // TOC entries & page plan
      var entries = chosen.map(function (uid) { var u = units[uid]; return { uid: uid, title: u.lesson_id.replace("ANS.", "") + " · " + u.heading, unit: u }; });
      var tocLines = []; entries.forEach(function (e) { F.wrap(e.title, 10.5, cw - 70).forEach(function (l, i) { tocLines.push({ e: e, text: l, first: i === 0 }); }); });
      var perPage = Math.floor((H - M.top - M.bottom - 60) / 16);
      var tocPages = opts.toc ? Math.max(1, Math.ceil(tocLines.length / perPage)) : 0;
      var titlePages = opts.title ? 1 : 0;
      var cursor = titlePages + tocPages;
      entries.forEach(function (e) { e.start = cursor; cursor += e.unit.pages; });
      var compStart = cursor;
      var pages = {};
      // title
      if (opts.title) {
        var p = doc.addPage(A4); var y = H - 150;
        F.draw(p, "AI-Native Startup", M.left, y, 30, true, L.rgb(0.12, 0.37, 0.55)); y -= 30;
        F.draw(p, "один основатель, команда ИИ-агентов", M.left, y, 14, false); y -= 50;
        F.draw(p, "Персональная подборка разделов", M.left, y, 20, true); y -= 28;
        [["Редакция", state.frag.release_id + " (кандидат технической редакции)"], ["Сформировано", stamp], ["Разделов", String(entries.length)],
         ["Первоисточник", siteUrl], ["Статус", "Веб-редакция для проверки — педагогический пилот не завершён"], ["ISBN", "не присвоен"]].forEach(function (kv) {
          F.draw(p, kv[0] + ":", M.left, y, 11, true); F.wrap(kv[1], 11, cw - 110).forEach(function (l) { F.draw(p, l, M.left + 110, y, 11, false); y -= 15; }); y -= 3;
        });
        y -= 20;
        F.wrap("Подборка собрана в браузере из утверждённых фрагментов одной редакции без изменения текста. Состав, хеши и digest манифеста — на последней странице.", 9.5, cw)
          .forEach(function (l) { F.draw(p, l, M.left, y, 9.5, false, L.rgb(0.35, 0.38, 0.42)); y -= 13; });
        pages.title = p;
      }
      var tocPageObjs = [];
      for (var t = 0; t < tocPages; t++) tocPageObjs.push(doc.addPage(A4));
      return Promise.all(chosen.map(function (uid) { return L.PDFDocument.load(bufs[uid]); })).then(function (srcs) {
        var chain = Promise.resolve();
        srcs.forEach(function (src, i) {
          chain = chain.then(function () {
            if (src.getPageCount() !== entries[i].unit.pages) throw new Error("Число страниц фрагмента " + entries[i].uid + " не совпадает с перечнем — сборка прервана.");
            return doc.copyPages(src, src.getPageIndices());
          }).then(function (cp) { cp.forEach(function (pg) { doc.addPage(pg); }); entries[i].firstPage = cp[0]; });
        });
        return chain;
      }).then(function () {
        // composition page (PDF-07)
        var cp = doc.addPage(A4), y = H - M.top;
        F.draw(cp, "Источники и состав подборки", M.left, y, 16, true); y -= 26;
        [["Редакция", state.frag.release_id], ["Commit источника", state.frag.source_commit_sha], ["Public manifest digest", state.frag.public_manifest_digest],
         ["Fragments digest", state.frag.fragments_digest], ["Сформировано", now.toISOString()], ["Сборщик", "ANS pdf-composer 0.1 · pdf-lib 1.17.1 · фрагменты: " + state.frag.renderer]]
          .forEach(function (kv) { F.draw(cp, kv[0] + ": ", M.left, y, 9, true); F.wrap(kv[1], 8.5, cw - 130).forEach(function (l) { F.draw(cp, l, M.left + 130, y, 8.5, false); y -= 11; }); y -= 2; });
        y -= 10; F.draw(cp, "Единицы (unit_id · bundle_revision_hash · sha256 фрагмента):", M.left, y, 10, true); y -= 15;
        entries.forEach(function (e) {
          if (y < M.bottom + 20) { cp = doc.addPage(A4); y = H - M.top; }
          F.draw(cp, e.uid, M.left, y, 8.5, true); F.draw(cp, e.unit.bundle_revision_hash.slice(0, 32) + "…  " + e.unit.sha256.slice(0, 16) + "…", M.left + 95, y, 8, false); y -= 12;
        });
        y -= 10; F.wrap("Содержание формируется только выбором и порядком утверждённых единиц; языковая модель при сборке не используется. Учительские материалы в публичную подборку не входят.", 8.5, cw)
          .forEach(function (l) { if (y < M.bottom) { cp = doc.addPage(A4); y = H - M.top; } F.draw(cp, l, M.left, y, 8.5, false, L.rgb(0.35, 0.38, 0.42)); y -= 11; });
        var all = doc.getPages(), total = all.length;
        // TOC with real page numbers + links
        if (opts.toc) {
          var li = 0;
          tocPageObjs.forEach(function (pg, k) {
            var yy = H - M.top;
            if (k === 0) { F.draw(pg, "Оглавление", M.left, yy, 18, true); yy -= 34; } else yy -= 10;
            for (var n = 0; n < perPage && li < tocLines.length; n++, li++) {
              var line = tocLines[li]; F.draw(pg, line.text, M.left, yy, 10.5, false);
              if (line.first) {
                var num = String(line.e.start + 1), nw = F.width(num, 10.5, true);
                F.draw(pg, num, W - M.right - nw, yy, 10.5, true);
                linkAnnot(doc, pg, [M.left, yy - 3, W - M.right, yy + 11], all[line.e.start]);
              }
              yy -= 16;
            }
          });
          F.draw(tocPageObjs[tocPageObjs.length - 1], "Источники и состав подборки", M.left, M.bottom + 20, 10.5, false);
          var cn = String(compStart + 1); F.draw(tocPageObjs[tocPageObjs.length - 1], cn, W - M.right - F.width(cn, 10.5, true), M.bottom + 20, 10.5, true);
        }
        // footer page numbers on every page except the title page
        all.forEach(function (pg, i) {
          if (opts.title && i === 0) return;
          var txt = "AI-Native Startup · " + state.frag.release_id + " · подборка от " + now.toLocaleDateString("ru-RU") + " · стр. " + (i + 1) + " из " + total;
          var w = F.width(txt, 7.5, false);
          pg.drawRectangle({ x: (W - w) / 2 - 4, y: 18, width: w + 8, height: 13, color: L.rgb(1, 1, 1) });
          F.draw(pg, txt, (W - w) / 2, 22, 7.5, false, L.rgb(0.4, 0.42, 0.45));
        });
        // bookmarks: lessons -> units
        var byLesson = [];
        entries.forEach(function (e) { var last = byLesson[byLesson.length - 1]; if (!last || last.lesson !== e.unit.lesson_id) { last = { lesson: e.unit.lesson_id, title: e.unit.lesson_id.replace("ANS.", "") + ". " + e.unit.lesson_title, page: all[e.start], children: [] }; byLesson.push(last); } last.children.push({ title: e.unit.heading, page: all[e.start] }); });
        var outline = [];
        if (opts.title) outline.push({ title: "Титульный лист", page: all[0] });
        if (opts.toc) outline.push({ title: "Оглавление", page: tocPageObjs[0] });
        outline = outline.concat(byLesson); outline.push({ title: "Источники и состав подборки", page: all[compStart] });
        buildOutline(doc, outline);
        doc.setTitle("AI-Native Startup — подборка разделов (" + state.frag.release_id + ")");
        doc.setAuthor("AI-Native Startup, редакция " + state.frag.release_id);
        doc.setSubject("Персональная подборка: " + chosen.join(", "));
        doc.setKeywords(chosen.concat([state.frag.release_id, "manifest:" + state.frag.public_manifest_digest]));
        doc.setCreator("ANS pdf-composer 0.1 (browser)"); doc.setProducer("pdf-lib 1.17.1"); doc.setLanguage("ru-RU");
        doc.setCreationDate(now); doc.setModificationDate(now);
        prog.value = prog.max;
        return doc.save();
      });
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: "application/pdf" });
      var name = "ANS-" + state.frag.release_id + "-podborka-" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") + ".pdf";
      var a = el("a", { href: URL.createObjectURL(blob), download: name, class: "ans-btn ans-btn--primary", id: "ans-pdf-download", text: "Скачать " + name + " (" + Math.round(bytes.length / 1024) + " КБ)" });
      var out = $("#ans-pdf-result"); out.innerHTML = ""; out.appendChild(a); a.click();
      log("Готово: " + name); btn.disabled = false;
      window.ANS_PDF_LAST = { name: name, size: bytes.length };
    }).catch(function (e) {
      log("ОШИБКА: " + e.message); $("#ans-pdf-result").innerHTML = ""; $("#ans-pdf-result").appendChild(el("div", { class: "ans-msg ans-msg--err", role: "alert", text: e.message }));
      btn.disabled = false; window.ANS_PDF_LAST = { error: e.message };
    });
  }

  function init() {
    if (!$("#ans-pdf-app")) return;
    L = window.PDFLib;
    if (!L || !window.fontkit || !window.crypto || !crypto.subtle) { $("#ans-pdf-app").innerHTML = "<p class='ans-msg ans-msg--err'>Браузер не поддерживает сборку PDF (нужны WebCrypto и современный JavaScript). Скачайте готовые PDF уроков на странице «Загрузки».</p>"; return; }
    Promise.all([fetch(root + "pdf/fragments.json").then(function (r) { return r.json(); }), fetch(root + "manifest.json").then(function (r) { return r.json(); })])
      .then(function (r) {
        state.frag = r[0]; state.manifest = r[1];
        if (state.frag.release_id !== ANS.release_id || state.manifest.release_id !== ANS.release_id || state.frag.public_manifest_digest !== state.manifest.public_manifest_digest)
          throw new Error("Фрагменты и манифест относятся к разным редакциям — сборка запрещена (PDF-02).");
        var known = {}; state.frag.lessons.forEach(function (l) { l.units.forEach(function (u) { known[u.unit_id] = 1; }); });
        state.order = getSel().filter(function (u) { return known[u]; });
        render(); $("#ans-pdf-build").addEventListener("click", build);
      }).catch(function (e) { $("#ans-pdf-tree").textContent = "Не удалось загрузить перечень фрагментов: " + e.message; });
  }
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(init); else document.addEventListener("DOMContentLoaded", init);
})();
