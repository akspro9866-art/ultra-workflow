/* Ultra deterministic easing / motion runtime (offline vendor copy).
 *
 * Injected automatically into custom scenes as `window.UltraEase`; also shipped
 * for hand-authored HTML that wants the same curves as the Ultra compiler.
 */
(function () {
  "use strict";
  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function linear(t) {
    return clamp(t, 0, 1);
  }
  function easeInQuad(t) {
    t = clamp(t, 0, 1);
    return t * t;
  }
  function easeOutQuad(t) {
    t = clamp(t, 0, 1);
    return t * (2 - t);
  }
  function easeInOutQuad(t) {
    t = clamp(t, 0, 1);
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }
  function easeInCubic(t) {
    t = clamp(t, 0, 1);
    return t * t * t;
  }
  function easeOutCubic(t) {
    t = clamp(t, 0, 1);
    var p = t - 1;
    return p * p * p + 1;
  }
  function easeInOutCubic(t) {
    t = clamp(t, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 + 4 * Math.pow(t - 1, 3);
  }
  function easeOutBack(t) {
    t = clamp(t, 0, 1);
    var c1 = 1.70158;
    var c3 = c1 + 1;
    var p = t - 1;
    return 1 + c3 * p * p * p + c1 * p * p;
  }
  function easeOutExpo(t) {
    t = clamp(t, 0, 1);
    return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }
  function easeInOutSine(t) {
    t = clamp(t, 0, 1);
    return -(Math.cos(Math.PI * t) - 1) / 2;
  }
  /** Deterministic damped spring progress in 0..~1 (no wall clock). */
  function spring(t, stiffness, damping) {
    var k = stiffness === undefined ? 12 : stiffness;
    var d = damping === undefined ? 6 : damping;
    t = Math.max(0, t);
    if (t === 0) return 0;
    if (t >= 2) return 1;
    return 1 - Math.exp(-d * t) * Math.cos(k * t);
  }
  var curves = {
    linear: linear,
    easeInQuad: easeInQuad,
    easeOutQuad: easeOutQuad,
    easeInOutQuad: easeInOutQuad,
    easeInCubic: easeInCubic,
    easeOutCubic: easeOutCubic,
    easeInOutCubic: easeInOutCubic,
    easeOutBack: easeOutBack,
    easeOutExpo: easeOutExpo,
    easeInOutSine: easeInOutSine,
    spring: spring
  };
  curves.clamp = clamp;
  window.UltraEase = curves;
})();
