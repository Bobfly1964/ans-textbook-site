/* AI-Native Startup reader layer: unit toolbars, PDF selection, review dialog (S2 PoC).
   Works on top of static HTML; if this script or the review API fails, reading/search/PDF still work. */
(function () {
  "use strict";
  var ANS = window.ANS || {};
  var REL = ANS.release_id || "r0000";
  var API = (ANS.feedback_api || "/api/v1").replace(/\/$/, "");
  var SEL_KEY = "ans:" + REL + ":pdf-selection";
  var KIND = [["ERRATA", "Ошибка"], ["CLARITY", "Неясно"], ["METHOD", "Методика / некорректная практика"], ["TECH_STALE", "Устарело"],
    ["FIGURE", "Неверное изображение"], ["BROKEN_LINK", "Сломанная ссылка"], ["ACCESSIBILITY", "Доступность"],
    ["SECURITY", "Безопасность"], ["SUGGESTION", "Предложение"]];
  var SEV = [["NORMAL", "Обычная"], ["LOW", "Низкая"], ["HIGH", "Высокая"], ["CRITICAL", "Критическая"]];
  var STATUS_RU = { OPEN: "Принято к разбору", TRIAGED: "Принято к разбору", FIX_PROPOSED: "В работе", EDITOR_ACCEPTED: "В работе",
    REJECTED: "Отклонено", DUPLICATE: "Дубликат", FIX_RELEASED: "Исправлено", VERIFIED: "Исправлено и проверено", REOPENED: "Открыто повторно" };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function article() { return document.querySelector(".md-content__inner.md-typeset") || document.querySelector("article"); }
  function headingText(h) { var c = h.cloneNode(true); c.querySelectorAll(".headerlink, .ans-unit-tools").forEach(function (x) { x.remove(); }); return c.textContent.trim(); }

  /* ---------- unit geometry ---------- */
  function unitHeadings() { var a = article(); return a ? Array.prototype.slice.call(a.querySelectorAll("[data-unit-id]")) : []; }
  function topChild(node) {
    var a = article(); if (!a) return null;
    while (node && node.parentNode !== a) node = node.parentNode;
    return node;
  }
  function unitOf(node) {
    var n = topChild(node && node.nodeType === 3 ? node.parentNode : node);
    while (n) { if (n.matches && n.matches("[data-unit-id]")) return n; n = n.previousElementSibling; }
    return null;
  }
  function nextUnit(h) { var hs = unitHeadings(); var i = hs.indexOf(h); return i >= 0 ? hs[i + 1] || null : null; }
  function textBetween(startNode, startOffset, endNode, endOffset) {
    // context for re-anchoring: book text only — our toolbars, permalinks and popups are excluded
    var r = document.createRange(); r.setStart(startNode, startOffset);
    if (endNode) r.setEnd(endNode, endOffset); else { var a = article(); r.setEnd(a, a.childNodes.length); }
    var frag = r.cloneContents();
    Array.prototype.forEach.call(frag.querySelectorAll(".ans-unit-tools, .headerlink, .ans-selection-pop, .ans-lesson-card"), function (x) { x.remove(); });
    return (frag.textContent || "").replace(/¶/g, "").replace(/\s+/g, " ");
  }
  function selectionContext() {
    var s = window.getSelection(); if (!s || s.isCollapsed || s.rangeCount === 0) return null;
    var r = s.getRangeAt(0); var quote = s.toString().replace(/\s+/g, " ").trim();
    if (quote.length < 2) return null;
    var u1 = unitOf(r.startContainer), u2 = unitOf(r.endContainer);
    if (!u1 || u1 !== u2) return { error: "Выделите текст внутри одного раздела." };
    var nu = nextUnit(u1);
    var prefix = textBetween(u1, 0, r.startContainer, r.startOffset).slice(-80).trimStart();
    var suffix = nu ? textBetween(r.endContainer, r.endOffset, nu, 0) : textBetween(r.endContainer, r.endOffset, null);
    return { unit: u1, quote: quote.slice(0, 1200), prefix: prefix.slice(-160), suffix: suffix.slice(0, 80).trimEnd() };
  }

  /* ---------- PDF selection (shared with pdf-builder page) ---------- */
  function getSel() { return store(SEL_KEY) || []; }
  function toggleSel(uid) {
    var s = getSel(); var i = s.indexOf(uid);
    if (i >= 0) s.splice(i, 1); else s.push(uid);
    store(SEL_KEY, s); return i < 0;
  }

  /* ---------- toolbars ---------- */
  function decorate() {
    unitHeadings().forEach(function (h) {
      if (h.nextElementSibling && h.nextElementSibling.classList.contains("ans-unit-tools")) return;
      var uid = h.getAttribute("data-unit-id");
      var inSel = getSel().indexOf(uid) >= 0;
      var bar = el("div", { class: "ans-unit-tools ans-ui", role: "group", "aria-label": "Действия с разделом " + uid }, [
        el("span", { class: "ans-unit-id", text: uid }),
        el("button", { type: "button", class: "ans-btn", "data-action": "review", onclick: function () { openDialog(h, selectionContext()); } }, ["Замечание к разделу"]),
        uid.indexOf(".S") > 0 ? el("button", {
          type: "button", class: "ans-btn", "aria-pressed": String(inSel), "data-action": "pdf",
          onclick: function (e) { var on = toggleSel(uid); e.currentTarget.setAttribute("aria-pressed", String(on)); e.currentTarget.textContent = on ? "В подборке PDF ✓" : "В мою PDF-подборку"; }
        }, [inSel ? "В подборке PDF ✓" : "В мою PDF-подборку"]) : null,
        teacherLink(h),
        el("span", { class: "ans-review-badge", "data-badge-for": uid })
      ]);
      h.insertAdjacentElement("afterend", bar);
    });
    loadStatuses();
  }

  function teacherLink(h) {
    // UI-05: link to the bound methodology unit of the SAME release. Access control is server-side
    // (our gateway: 401/403; or GitHub for the private repo), never by hiding this link.
    var role = token(), t = (h.getAttribute("data-teacher-units") || "").split(" ").filter(Boolean);
    if (!t.length) return null;
    if (ANS.teacher_mode === "github-private") {
      var tl = (ANS.teacher_links || {})[h.getAttribute("data-lesson")];
      if (!tl) return null;
      var url = "https://github.com/" + ANS.github_repo + "/blob/" + ANS.source_commit_sha + "/" + tl.file + "?plain=1#L" + (tl.lines[t[0]] || 1);
      return el("a", { class: "ans-btn", href: url, rel: "nofollow noopener", target: "_blank", title: "Закрытое руководство в приватном репозитории (нужен вход GitHub)" },
        ["Методика " + t.map(function (x) { return x.split(".").pop(); }).join(", ") + " ↗"]);
    }
    if (["teacher", "editor", "owner"].indexOf(role) < 0) return null;
    var lesson = (h.getAttribute("data-lesson") || "").replace("ANS.", "");
    var root = (ANS.release_root || "/r/" + REL + "/").replace(/\/r\/[^/]+\/$/, "/");
    return el("a", { class: "ans-btn", href: root + "teacher/r/" + REL + "/" + lesson + "/#" + t[0].replace(/\./g, "-"), rel: "nofollow" }, ["Методика " + t.map(function (x) { return x.split(".").pop(); }).join(", ")]);
  }

  var pop = null;
  function onSelect() {
    if (pop) { pop.remove(); pop = null; }
    var ctx = selectionContext(); if (!ctx || ctx.error) return;
    var rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    pop = el("div", { class: "ans-selection-pop ans-ui" }, [
      el("button", { type: "button", class: "ans-btn ans-btn--primary", "data-action": "comment-selection", onmousedown: function (e) { e.preventDefault(); },
        onclick: function () { var c = selectionContext() || ctx; pop.remove(); pop = null; openDialog(c.unit, c); } }, ["Выделить и комментировать"])
    ]);
    pop.style.top = (window.scrollY + rect.bottom + 6) + "px";
    pop.style.left = Math.max(8, window.scrollX + rect.left) + "px";
    document.body.appendChild(pop);
  }

  /* ---------- review dialog ---------- */
  function token() { try { return sessionStorage.getItem("ans:reviewer-token") || ""; } catch (e) { return ""; } }
  function draftText(p) {
    return ["Замечание к учебнику AI-Native Startup", "Редакция: " + p.source_revision + " (" + p.source_commit_sha + ")",
      "Раздел: " + p.unit_id + " / hash " + p.unit_bundle_hash, "Тип: " + p.kind + ", важность: " + p.severity,
      "Цитата: «" + p.quote + "»", "Комментарий: " + p.comment, p.suggested_replacement ? "Предлагаемая правка: " + p.suggested_replacement : ""].filter(Boolean).join("\n");
  }
  function openDialog(h, ctx) {
    var old = document.getElementById("ans-review-dialog"); if (old) old.remove();
    if (ctx && ctx.error) ctx = null;
    var uid = h.getAttribute("data-unit-id"), hash = h.getAttribute("data-bundle-hash"), lesson = h.getAttribute("data-lesson");
    var msg = el("div", { class: "ans-msg ans-msg--info", role: "status", "aria-live": "polite" }, [
      ANS.feedback_mode === "github-prefill" ? "Замечание откроется в GitHub (Issues приватного репозитория учебника) уже заполненным — останется нажать «Submit new issue»."
        : token() ? "Вы вошли как рецензент." : "Для отправки нужен вход рецензента (приглашение редакции)."]);
    var quote = el("textarea", { name: "quote", rows: "2", maxlength: "1200", "aria-describedby": "ans-quote-help" }); quote.value = ctx ? ctx.quote : "";
    var form = el("form", { method: "dialog", novalidate: "" }, [
      el("dl", { class: "ans-context" }, [
        el("dt", { text: "Курс" }), el("dd", { text: ANS.course_id }),
        el("dt", { text: "Редакция" }), el("dd", { text: REL + " · " + (ANS.source_commit_sha || "").slice(0, 12) }),
        el("dt", { text: "Урок" }), el("dd", { text: lesson }),
        el("dt", { text: "Раздел" }), el("dd", { text: uid + " — " + headingText(h) }),
        el("dt", { text: "Хеш раздела" }), el("dd", { text: hash })
      ]),
      ctx ? el("div", {}, [el("strong", { text: "Выделенный фрагмент" }), el("blockquote", { text: ctx.quote })]) : null,
      el("label", {}, ["Цитата (можно уточнить)", quote, el("small", { id: "ans-quote-help", text: "Фрагмент + контекст до/после сохраняются, чтобы замечание не «переехало» на другой текст в следующей редакции." })]),
      el("div", { class: "ans-row" }, [
        el("label", {}, ["Тип замечания", sel("kind", KIND)]),
        el("label", {}, ["Важность", sel("severity", SEV)])
      ]),
      el("label", {}, ["Комментарий", el("textarea", { name: "comment", rows: "4", required: "", minlength: "6", maxlength: "4000" })]),
      el("label", {}, ["Было → стало (необязательно)", el("textarea", { name: "suggested_replacement", rows: "2", maxlength: "3000" })]),
      el("label", {}, ["Ссылка на источник (https://, необязательно)", el("input", { name: "proof_url", type: "url", inputmode: "url" })]),
      (token() || ANS.feedback_mode === "github-prefill") ? null : el("label", {}, ["Код приглашения рецензента", el("input", { name: "invite", type: "password", autocomplete: "off" })]),
      msg,
      el("div", { class: "ans-actions" }, [
        el("button", { type: "submit", class: "ans-btn ans-btn--primary", "data-action": "send" }, ["Отправить замечание"]),
        el("button", { type: "button", class: "ans-btn", onclick: function () { dlg.close(); } }, ["Отмена"])
      ])
    ]);
    var dlg = el("dialog", { id: "ans-review-dialog", class: "ans-dialog", "aria-labelledby": "ans-review-title" }, [
      el("header", {}, [el("h2", { id: "ans-review-title", text: "Замечание к разделу" }), el("button", { type: "button", class: "ans-btn", "aria-label": "Закрыть", onclick: function () { dlg.close(); } }, ["×"])]),
      form
    ]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = new FormData(form);
      var payload = {
        kind: f.get("kind"), severity: f.get("severity"), course_id: ANS.course_id, source_revision: REL,
        source_commit_sha: ANS.source_commit_sha, lesson_id: lesson, unit_id: uid, unit_bundle_hash: hash,
        quote: String(f.get("quote") || "").trim(), prefix: ctx ? ctx.prefix : "", suffix: ctx ? ctx.suffix : "",
        comment: String(f.get("comment") || "").trim(), suggested_replacement: String(f.get("suggested_replacement") || "").trim() || null,
        proof_urls: f.get("proof_url") ? [String(f.get("proof_url")).trim()] : []
      };
      if (payload.comment.length < 6) { show(msg, "err", "Комментарий слишком короткий (минимум 6 символов)."); return; }
      if (ANS.feedback_mode === "github-prefill") { githubPrefill(payload, h, msg); return; }
      submit(payload, String(f.get("invite") || ""), msg, form);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    form.querySelector("textarea[name=comment]").focus();
  }
  function sel(name, opts) { return el("select", { name: name }, opts.map(function (o) { return el("option", { value: o[0], text: o[1] }); })); }
  function show(box, kind, text, extra) { box.className = "ans-msg ans-msg--" + kind; box.textContent = text; if (extra) box.appendChild(extra); }

  /* Interim mode (owner-only use, DEC-2026-10-15 OD-09): the same structured record as the gateway would create,
     prefilled into a new Issue of the PRIVATE content repo. Nothing is claimed as sent until GitHub confirms. */
  function fence(t) { return "````text\n" + String(t || "").replace(/`{3,}/g, function (m) { return m.replace(/`/g, "ˋ"); }) + "\n````"; }
  function githubPrefill(p, h, msg) {
    var meta = { kind: p.kind, severity: p.severity, source_revision: p.source_revision, source_commit_sha: p.source_commit_sha,
      lesson_id: p.lesson_id, unit_id: p.unit_id, unit_bundle_hash: p.unit_bundle_hash, status: "OPEN",
      binding: { revision: p.source_revision, unit_id: p.unit_id, bundle_hash: p.unit_bundle_hash, migrated_from: null } };
    var title = "[" + p.kind + "/" + p.severity + "] " + p.unit_id + " (" + p.source_revision + ") — " + p.comment.slice(0, 60).replace(/\s+/g, " ");
    var body = ["**Замечание к учебнику** · статус `OPEN` · id = `REV-" + p.source_revision + "-<номер этого Issue>`", "",
      "| Поле | Значение |", "|---|---|",
      "| Редакция / commit | `" + p.source_revision + "` / `" + p.source_commit_sha + "` |",
      "| Урок / раздел | `" + p.lesson_id + "` / `" + p.unit_id + "` — " + headingText(h).replace(/[|<>]/g, " ") + " |",
      "| Хеш раздела | `" + p.unit_bundle_hash + "` |", "| Тип / важность | `" + p.kind + "` / `" + p.severity + "` |", "",
      "**Цитата**", fence(p.quote), "**Контекст до / после**", fence("…" + p.prefix + "⟦" + p.quote + "⟧" + p.suffix + "…"),
      "**Комментарий**", fence(p.comment)];
    if (p.suggested_replacement) body.push("**Было → стало (предложение)**", fence(p.suggested_replacement));
    if (p.proof_urls.length) body.push("**Источники**", fence(p.proof_urls.join("\n")));
    body.push("", "> Замечание не меняет опубликованную редакцию: исправление — через patch → verdict → новая редакция.", "",
      "<!-- ans-review " + JSON.stringify(meta).replace(/--/g, "\\u002d\\u002d") + " -->");
    var labels = ["ans-review", "kind:" + p.kind, "severity:" + p.severity, "lesson:" + p.lesson_id, "unit:" + p.unit_id, "revision:" + p.source_revision].join(",");
    var b = body.join("\n"); if (b.length > 6000) b = b.slice(0, 6000) + "\n…(обрезано)";
    var url = "https://github.com/" + ANS.github_repo + "/issues/new?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(b) + "&labels=" + encodeURIComponent(labels);
    var w = window.open(url, "_blank");  // no "noopener" feature: with it window.open() returns null even on success
    if (w) { try { w.opener = null; } catch (e) { /* cross-origin already */ } }
    var a = el("a", { href: url, target: "_blank", rel: "noopener", text: " Открыть заново" });
    show(msg, w ? "info" : "err", w ? "Открыта вкладка GitHub с заполненным замечанием. Оно будет сохранено только после «Submit new issue»; номер Issue = номер замечания." : "Браузер заблокировал новую вкладку.", a);
    window.ANS_LAST_PREFILL = url;
  }

  function login(invite) {
    return fetch(API + "/session", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-ANS-CSRF": "1" }, body: JSON.stringify({ invite_token: invite }) })
      .then(function (r) { if (!r.ok) throw new Error("login " + r.status); return r.json(); })
      .then(function (j) { try { sessionStorage.setItem("ans:reviewer-token", j.role); } catch (e) {} return j; });
  }
  function submit(payload, invite, msg, form) {
    var btn = form.querySelector("[data-action=send]"); btn.setAttribute("aria-disabled", "true"); btn.disabled = true;
    show(msg, "info", "Отправляю…");
    var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
    var chain = (!token() && invite) ? login(invite) : Promise.resolve();
    chain.then(function () {
      return fetch(API + "/reviews", { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-ANS-CSRF": "1", "Idempotency-Key": idem }, body: JSON.stringify(payload) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      if (res.status === 201 || res.status === 200) {
        var mine = store("ans:my-reviews") || []; mine.push({ review_id: res.body.review_id, unit_id: payload.unit_id, revision: REL }); store("ans:my-reviews", mine);
        var a = res.body.url ? el("a", { href: res.body.url, text: " Открыть обращение" }) : null;
        show(msg, "ok", "Замечание принято: " + res.body.review_id + " — статус «" + (STATUS_RU[res.body.status] || res.body.status) + "».", a);
        form.querySelector("[data-action=send]").remove();
        loadStatuses();
        return;
      }
      var reason = {
        401: "Нужен вход рецензента — замечание не отправлено.", 403: "Недостаточно прав — замечание не отправлено.",
        409: "Привязка не совпадает с манифестом редакции (раздел/хеш/коммит) — замечание не принято.",
        422: "Данные замечания не прошли проверку: " + ((res.body.errors || []).join("; ") || "ошибка формата"),
        429: "Слишком много замечаний подряд — попробуйте позже."
      }[res.status] || ("Сервис замечаний ответил ошибкой " + res.status + ".");
      failure(msg, form, payload, reason);
    }).catch(function () {
      failure(msg, form, payload, "Сервис замечаний недоступен. Замечание НЕ отправлено.");
    });
  }
  function failure(msg, form, payload, reason) {
    var b = form.querySelector("[data-action=send]"); if (b) { b.disabled = false; b.removeAttribute("aria-disabled"); }
    var copy = el("button", { type: "button", class: "ans-btn", "data-action": "copy-draft", onclick: function () {
      var t = draftText(payload);
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { copy.textContent = "Скопировано"; })
        .catch(function () { var ta = el("textarea", { rows: "6", readonly: "" }); ta.value = t; msg.appendChild(ta); ta.select(); });
    } }, ["Скопировать текст замечания"]);
    show(msg, "err", reason + " ", copy);
  }

  function loadStatuses() {
    if (!token() || ANS.feedback_mode === "github-prefill") return;
    var hs = unitHeadings(); if (!hs.length) return;
    var lesson = hs[0].getAttribute("data-lesson");
    fetch(API + "/reviews?revision=" + encodeURIComponent(REL) + "&lesson_id=" + encodeURIComponent(lesson), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (j) {
        var by = {};
        (j.items || []).forEach(function (it) { (by[it.unit_id] = by[it.unit_id] || []).push(it); });
        Object.keys(by).forEach(function (uid) {
          var b = document.querySelector('[data-badge-for="' + uid + '"]'); if (!b) return;
          var last = by[uid][by[uid].length - 1];
          b.textContent = by[uid].length + " замеч. · последнее: " + last.review_id + " — " + (STATUS_RU[last.status] || last.status) +
            (last.resolved_in_revision ? " в " + last.resolved_in_revision : "");
        });
      }).catch(function () { /* statuses are optional */ });
  }

  /* UI-06/UI-09: an old release stays unchanged; a notice points to the same unit in the current release.
     Data comes from /r/state.json (mutable site root), never from rewriting this release's pages. */
  function newerReleaseNotice() {
    var root = ANS.release_root || ""; if (!root) return;
    fetch(root + "../state.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st || !st.current) return;
      var revoked = (st.revoked || {})[REL];
      if (st.current === REL && !revoked) return;
      var a = article(); if (!a) return;
      var rel = location.pathname.split("/r/" + REL + "/")[1] || "";
      var target = root.replace("/r/" + REL + "/", "/r/" + st.current + "/") + rel;
      var box = el("div", { class: "ans-withheld ans-ui", role: "alert" }, [
        revoked ? el("strong", { text: "Редакция " + REL + " отозвана: " + revoked.reason + ". " }) : null,
        st.current !== REL ? "Вы читаете редакцию " + REL + " — она не меняется. Актуальная редакция — " + st.current + ": " : "",
        st.current !== REL ? el("a", { href: target + location.hash, "data-target": target, text: "этот раздел в " + st.current }) : null
      ]);
      a.insertBefore(box, a.firstChild);
      if (st.current !== REL) {  // unit removed/renamed in the current release -> explain instead of silently opening other text
        fetch(target, { method: "HEAD" }).then(function (r) {
          if (!r.ok) { box.lastChild.textContent = "оглавление " + st.current; box.lastChild.href = root.replace("/r/" + REL + "/", "/r/" + st.current + "/"); box.appendChild(document.createTextNode(" (этой страницы в новой редакции нет — см. «Изменения»)")); }
        }).catch(function () {});
      }
    }).catch(function () {});
  }

  function init() {
    decorate();
    newerReleaseNotice();
    var a = article();
    if (a && unitHeadings().length) {
      a.addEventListener("mouseup", function () { setTimeout(onSelect, 0); });
      a.addEventListener("keyup", function (e) { if (e.shiftKey) setTimeout(onSelect, 0); });
    }
  }
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(init); else document.addEventListener("DOMContentLoaded", init);
  window.ANS_TOOLS = { getSel: getSel, SEL_KEY: SEL_KEY, openDialog: openDialog };
})();
