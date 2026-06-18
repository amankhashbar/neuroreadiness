/* =============================================================
   Cortex — landing.js
   Dependency-free landing-page motion: scroll reveals, score-ring
   draw-in, number count-ups, the live PPG waveform, hero parallax,
   and the floating-nav scroll state. Vanilla JS + canvas + SVG only,
   to match the no-build-step architecture. Every animation has a
   reduced-motion fallback that serves the static end-state.
   ============================================================= */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var raf = [];
  var $ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ---- Score ring: animate stroke-dashoffset to the data-ring value -------
  function animRing(el) {
    var pct = parseFloat(el.getAttribute("data-ring")) / 100;
    var target = 326.7 * (1 - pct);
    if (reduced) { el.style.strokeDashoffset = String(target); return; }
    el.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.16,1,.3,1)";
    requestAnimationFrame(function () { el.style.strokeDashoffset = String(target); });
  }

  // ---- Count-up: ease a number from 0 to data-countup -----------------------
  function animCount(el) {
    var target = parseFloat(el.getAttribute("data-countup"));
    if (reduced) { el.textContent = String(target); return; }
    var dur = 900, t0 = performance.now();
    var step = function (now) {
      var p = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e);
      if (p < 1) raf.push(requestAnimationFrame(step));
    };
    raf.push(requestAnimationFrame(step));
  }

  // ---- Live PPG-style waveform on a canvas ---------------------------------
  function drawWave(canvas, phase, teal) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    var grad = ctx.createLinearGradient(0, 0, W, 0);
    if (teal) { grad.addColorStop(0, "rgba(45,212,191,0.15)"); grad.addColorStop(1, "#2DD4BF"); }
    else { grad.addColorStop(0, "rgba(59,130,246,0.15)"); grad.addColorStop(1, "#3B82F6"); }
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    var mid = H * 0.55, beat = 78;
    for (var x = 0; x <= W; x += 2) {
      var t = (x + phase) % beat;
      var y = mid + Math.sin((x + phase) * 0.05) * 4;
      var u = t / beat;
      if (u < 0.18) y -= Math.sin(u / 0.18 * Math.PI) * (H * 0.32);
      else if (u < 0.30) y += Math.sin((u - 0.18) / 0.12 * Math.PI) * (H * 0.12);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function initWaveforms() {
    $("canvas[data-waveform]").forEach(function (canvas) {
      var teal = canvas.getAttribute("data-waveform") === "teal";
      drawWave(canvas, 0, teal);            // static frame first, always visible
      if (reduced) return;
      var phase = 0;
      var tick = function () { phase += 1.1; drawWave(canvas, phase, teal); raf.push(requestAnimationFrame(tick)); };
      raf.push(requestAnimationFrame(tick));
    });
  }

  // ---- Scroll reveals + ring/count triggers --------------------------------
  function initReveals() {
    var els = $("[data-reveal]");
    var show = function (el) {
      var delay = parseInt(el.getAttribute("data-reveal-delay") || "0", 10);
      setTimeout(function () { el.classList.add("in"); }, reduced ? 0 : delay);
    };
    if (reduced || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          show(e.target); io.unobserve(e.target);
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
      els.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) show(el);
        else io.observe(el);
      });
      // Safety net: never leave content hidden if IO is throttled.
      setTimeout(function () { els.forEach(function (el) { el.classList.add("in"); }); }, 2500);
    }

    // rings + countups fire on their own visibility
    var trigList = $("[data-ring],[data-countup]");
    if (reduced || !("IntersectionObserver" in window)) {
      trigList.forEach(function (el) {
        if (el.hasAttribute("data-ring")) animRing(el);
        if (el.hasAttribute("data-countup")) animCount(el);
      });
      return;
    }
    var trig = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        if (e.target.hasAttribute("data-ring")) animRing(e.target);
        if (e.target.hasAttribute("data-countup")) animCount(e.target);
        trig.unobserve(e.target);
      });
    }, { threshold: 0.4 });
    trigList.forEach(function (el) { trig.observe(el); });
  }

  // ---- Hero parallax (subtle translateY on the floating board) -------------
  function initParallax() {
    if (reduced) return;
    var layers = $("[data-cx-parallax]");
    if (!layers.length) return;
    var onScroll = function () {
      var y = window.scrollY;
      layers.forEach(function (el) {
        var sp = parseFloat(el.getAttribute("data-cx-parallax")) || 0.15;
        el.style.transform = "translateY(" + (y * sp) + "px)";
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---- Floating nav: shrink + gain opacity on scroll, plus scroll-spy ------
  // Highlights the nav link whose section is currently in view, giving the
  // landing nav the same glowing active state the app's nav has.
  function initNav() {
    var nav = document.querySelector("[data-cx-nav]");
    if (!nav) return;
    var onScroll = function () {
      var s = window.scrollY > 30;
      nav.style.padding = s ? "8px 12px 8px 18px" : "11px 14px 11px 20px";
      nav.style.background = s ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.6)";
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Scroll-spy: map each nav link to its target section, then flag the
    // section nearest the top of the viewport as active.
    var links = $("[data-cx-link]");
    var spy = links.map(function (a) {
      var id = (a.getAttribute("href") || "").replace("#", "");
      return { link: a, section: id ? document.getElementById(id) : null };
    }).filter(function (s) { return s.section; });
    if (!spy.length) return;

    var setActive = function (active) {
      spy.forEach(function (s) { s.link.classList.toggle("active", s.link === active); });
    };
    var onSpy = function () {
      // Anchor a little below the fixed nav so the active link flips as a
      // section's heading clears the bar.
      var line = window.scrollY + 120;
      var current = null;
      spy.forEach(function (s) { if (s.section.offsetTop <= line) current = s.link; });
      // Clear highlight while still in the hero (above the first section).
      setActive(current);
    };
    onSpy();
    window.addEventListener("scroll", onSpy, { passive: true });
    window.addEventListener("resize", onSpy, { passive: true });
  }

  // ---- Mobile dropdown menu: burger toggles the panel ----------------------
  function initMobileMenu() {
    var burger = document.getElementById("nav-burger");
    var menu = document.getElementById("mobile-menu");
    if (!burger || !menu) return;
    var setOpen = function (open) {
      menu.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    burger.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(!menu.classList.contains("open"));
    });
    // Close on link tap, outside click, or scroll.
    menu.querySelectorAll("[data-mm-link]").forEach(function (a) {
      a.addEventListener("click", function () { setOpen(false); });
    });
    document.addEventListener("click", function (e) {
      if (menu.classList.contains("open") && !menu.contains(e.target) && e.target !== burger) setOpen(false);
    });
    window.addEventListener("scroll", function () { if (menu.classList.contains("open")) setOpen(false); }, { passive: true });
  }

  function start() {
    initReveals();
    initWaveforms();
    initParallax();
    initNav();
    initMobileMenu();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
