(function () {
  'use strict';

  // =========================================================================
  // STATE
  // =========================================================================
  var pointA = null;
  var pointB = null;
  var loopActive = false;
  var fadeEnabled = false;
  var loopCount = 0;
  var speed = 1.0;
  var activeSlot = null;
  var slots = [{ a: null, b: null }, { a: null, b: null }, { a: null, b: null }, { a: null, b: null }, { a: null, b: null }];
  var rafId = null;
  var bgInterval = null;
  var isPolling = false;
  var cardOpen = false;
  var currentTrackKey = null;

  var SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5];
  var STORAGE_PREFIX = 'ab_loop_v1_';
  var FADE_DURATION = 500;

  // =========================================================================
  // TRACK KEY
  // =========================================================================
  function getTrackKey() {
    var title = document.querySelector('[data-testid="context-item-link"]');
    var artist = document.querySelector('[data-testid="context-item-info-artist"]')
      || document.querySelector('[data-testid="now-playing-bar"] a:last-child');
    var t = title ? title.textContent.trim() : '';
    var a = artist ? artist.textContent.trim() : '';
    if (!t) return null;
    return (t + '__' + a).replace(/[^a-zA-Z0-9_\-]/g, '_');
  }

  // =========================================================================
  // PERSISTENCE
  // =========================================================================
  function saveToStorage() {
    var key = currentTrackKey;
    if (!key) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({
        slots: slots, activeSlot: activeSlot, a: pointA, b: pointB
      }));
    } catch (e) { }
  }

  function loadFromStorage(key) {
    try {
      var raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function applyTrackData(key) {
    // Hard reset all state
    pointA = null; pointB = null;
    loopActive = false; loopCount = 0; activeSlot = null;
    slots = [{ a: null, b: null }, { a: null, b: null }, { a: null, b: null }, { a: null, b: null }, { a: null, b: null }];
    stopPolling();

    currentTrackKey = key;

    // Load saved data for this track
    if (key) {
      var saved = loadFromStorage(key);
      if (saved) {
        slots = saved.slots || slots;
        activeSlot = saved.activeSlot != null ? saved.activeSlot : null;
        pointA = saved.a != null ? saved.a : null;
        pointB = saved.b != null ? saved.b : null;
      }
    }

    startPolling();
    updateProgressOverlay();
    refresh();
  }

  // =========================================================================
  // TRACK CHANGE — watch title element via MutationObserver
  // =========================================================================
  var trackObserver = null;

  function initTrackWatcher() {
    if (trackObserver) return;

    function checkTitle() {
      var key = getTrackKey();
      if (key && key !== currentTrackKey) {
        applyTrackData(key);
      }
    }

    // Watch the now-playing bar for any DOM changes (title swap)
    var bar = document.querySelector('[data-testid="now-playing-bar"]');
    if (!bar) return;

    trackObserver = new MutationObserver(checkTitle);
    trackObserver.observe(bar, { childList: true, subtree: true, characterData: true });

    // Initial load
    checkTitle();
  }

  // =========================================================================
  // PROGRESS BAR FIBER
  // =========================================================================
  function getProgressProps() {
    var bar = document.querySelector('[data-testid="progress-bar"]');
    if (!bar) return null;
    var fkey = Object.keys(bar).find(function (k) {
      return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
    });
    if (!fkey) return null;
    var node = bar[fkey]; var depth = 0;
    while (node) {
      depth++;
      var props = node.memoizedProps || node.pendingProps;
      if (props && depth === 4 && typeof props.onDragEnd === 'function' && typeof props.max === 'number') return props;
      if (depth > 10) break;
      node = node.return;
    }
    return null;
  }

  // Own clock position tracking.
  //
  // Core insight: props.value updates every ~1000ms but returns slightly
  // different floats on every call due to Spotify's internal interpolation.
  // Comparing raw === _lastRaw therefore always fails, causing constant resyncs.
  //
  // Fix: bucket the raw value to 500ms resolution for change detection.
  // When a genuine new 1s tick arrives, only resync if our clock has drifted
  // more than 1.5s (genuine seek). Otherwise keep our clock running freely.

  var _clockAnchorPos = null; // ms at last hard sync
  var _clockAnchorT = null; // performance.now() at last hard sync
  var _clockBucket = null; // last seen 500ms-bucketed raw value

  function getRawPosition() {
    var props = getProgressProps();
    if (props && typeof props.value === 'number') return props.value;
    return null;
  }

  // Called sparingly — only when we need to force a resync (track change, seek)
  function hardSyncClock(posMs) {
    _clockAnchorPos = posMs;
    _clockAnchorT = performance.now();
    _clockBucket = Math.round(posMs / 500);
  }

  // Called every poll tick — only resyncs on genuine new Spotify ticks or seeks
  function maybeSyncClock() {
    var raw = getRawPosition();
    if (raw === null) return;

    var bucket = Math.round(raw / 500); // 500ms buckets

    if (_clockAnchorPos === null) {
      // First ever sync
      hardSyncClock(raw);
      return;
    }

    if (bucket === _clockBucket) return; // same 500ms window, skip
    _clockBucket = bucket;

    // New 500ms bucket from Spotify. Check if it's a seek or normal tick.
    var predicted = _clockAnchorPos + (performance.now() - _clockAnchorT);
    var diff = Math.abs(raw - predicted);

    if (diff > 1500) {
      // Genuine seek — hard resync and handle loop state
      hardSyncClock(raw);
      if (loopActive && pointA !== null && pointB !== null) {
        if (raw < pointA - 300 || raw > pointB + 300) {
          loopActive = false;
          refresh();
        }
      }
    }
    // Normal tick (diff <= 1500ms): our clock is accurate, don't resync
  }

  function getPosition() {
    maybeSyncClock();
    if (_clockAnchorPos === null) return getRawPosition();
    // Our clock: runs freely from last hard sync
    return _clockAnchorPos + (performance.now() - _clockAnchorT);
  }

  window._abLoopGetPos = getPosition;
  window._abLoopDebug = {
    getPos: function () { return getPosition(); },
    getState: function () { return { loopActive: loopActive, pointA: pointA, pointB: pointB }; },
    startTest: function () {
      var state = window._abLoopDebug.getState();
      if (!state.pointB) { console.warn('[AB Test] Set B point first'); return; }
      var myB = state.pointB;
      var triggered = false;
      var t = setInterval(function () {
        var pos = getPosition();
        var diff = myB - pos;
        if (diff < 300 && diff > -500 && !triggered) {
          console.log('[AB Test] pos:', (pos / 1000).toFixed(3) + 's  diff from B:', diff.toFixed(1) + 'ms  loopActive:' + loopActive);
        }
        if (diff < -150 && !triggered) {
          console.warn('[AB Test] Passed B without triggering at pos:', (pos / 1000).toFixed(3) + 's  overshoot:', (-diff).toFixed(1) + 'ms');
          triggered = true;
        }
        if (pos < myB - 2000) { triggered = false; } // reset after looping back
      }, 16);
      console.log('[AB Test] Running — B is at', (myB / 1000).toFixed(3) + 's. Call _abLoopDebug.stopTest() to stop.');
      window._abLoopDebug._testInterval = t;
    },
    stopTest: function () {
      if (window._abLoopDebug._testInterval) {
        clearInterval(window._abLoopDebug._testInterval);
        console.log('[AB Test] Stopped');
      }
    }
  };

  function getDuration() {
    var props = getProgressProps();
    return (props && typeof props.max === 'number') ? props.max : null;
  }

  function seekTo(ms) {
    var props = getProgressProps();
    if (!props) return;
    props.onDragEnd(Math.max(0, Math.min(1, ms / props.max)), { wasDraggedBeforeReleased: false });
  }

  // =========================================================================
  // SPEED
  // =========================================================================
  function setSpeed(s) {
    speed = s;
    var audio = document.querySelector('audio');
    if (audio) audio.playbackRate = s;
    refresh();
    saveToStorage();
  }

  function cycleSpeed() {
    var idx = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]);
  }

  // =========================================================================
  // FADE + SEEK
  // =========================================================================
  function fadeOutAndSeek(targetMs) {
    if (!fadeEnabled) { seekTo(targetMs); hardSyncClock(targetMs); loopCount++; refresh(); return; }
    var audio = document.querySelector('audio');
    if (!audio) { seekTo(targetMs); hardSyncClock(targetMs); loopCount++; refresh(); return; }
    var startVol = audio.volume;
    var steps = 20; var stepTime = FADE_DURATION / steps; var step = 0;
    var out = setInterval(function () {
      audio.volume = startVol * (1 - (++step) / steps);
      if (step >= steps) {
        clearInterval(out);
        seekTo(targetMs); hardSyncClock(targetMs); loopCount++; refresh();
        var inStep = 0;
        var inp = setInterval(function () {
          audio.volume = startVol * ((++inStep) / steps);
          if (inStep >= steps) { clearInterval(inp); audio.volume = startVol; }
        }, stepTime);
      }
    }, stepTime);
  }

  // =========================================================================
  // POLLING (rAF + background interval)
  // =========================================================================
  function pollTick() {
    if (loopActive && pointA !== null && pointB !== null) {
      var pos = getPosition();
      if (pos !== null) {
        var lookahead = document.hidden ? 1500 : 150;
        if (pos >= pointB - lookahead) fadeOutAndSeek(pointA);
      }
    }
    updateProgressOverlay();
  }

  function rafLoop() {
    if (!isPolling) return;
    pollTick();
    rafId = requestAnimationFrame(rafLoop);
  }

  function onVisibilityChange() {
    if (!isPolling) return;
    if (!document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(rafLoop);
    } else {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }
  }

  function startPolling() {
    if (isPolling) return;
    isPolling = true;
    if (!document.hidden) rafId = requestAnimationFrame(rafLoop);
    bgInterval = setInterval(function () {
      if (document.hidden) pollTick();
      else if (!rafId) rafId = requestAnimationFrame(rafLoop);
    }, 500);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function stopPolling() {
    isPolling = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (bgInterval) { clearInterval(bgInterval); bgInterval = null; }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  // =========================================================================
  // KEYBOARD SHORTCUTS
  // =========================================================================
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable) return;
      if (e.altKey && e.key === 'a') { e.preventDefault(); setPointA(); }
      if (e.altKey && e.key === 'b') { e.preventDefault(); setPointB(); }
      if (e.altKey && e.key === 'l') { e.preventDefault(); toggleLoop(); }
      if (e.altKey && e.key === 'c') { e.preventDefault(); clearPoints(); }
      if (e.altKey && e.key === 'p') { e.preventDefault(); toggleCard(); }
    });
  }

  // =========================================================================
  // PROGRESS BAR OVERLAY
  // =========================================================================
  var overlayEl = null; var markerA = null; var markerB = null;

  function injectProgressOverlay() {
    var bar = document.querySelector('[data-testid="progress-bar"]');
    if (!bar || document.getElementById('ab-loop-overlay-wrap')) return;
    var wrap = document.createElement('div');
    wrap.id = 'ab-loop-overlay-wrap';
    overlayEl = document.createElement('div'); overlayEl.id = 'ab-loop-overlay';
    markerA = document.createElement('div'); markerA.id = 'ab-loop-marker-a';
    markerB = document.createElement('div'); markerB.id = 'ab-loop-marker-b';
    wrap.appendChild(overlayEl); wrap.appendChild(markerA); wrap.appendChild(markerB);
    bar.style.position = 'relative';
    bar.appendChild(wrap);
    updateProgressOverlay();
  }

  function updateProgressOverlay() {
    if (!overlayEl) return;
    var dur = getDuration();
    if (!dur || pointA === null) {
      overlayEl.style.display = markerA.style.display = markerB.style.display = 'none';
      return;
    }
    var aFrac = Math.max(0, Math.min(1, pointA / dur));
    var bFrac = pointB !== null ? Math.max(0, Math.min(1, pointB / dur)) : null;
    markerA.style.display = 'block';
    markerA.style.left = (aFrac * 100) + '%';
    if (bFrac !== null) {
      markerB.style.display = overlayEl.style.display = 'block';
      markerB.style.left = (bFrac * 100) + '%';
      overlayEl.style.left = (aFrac * 100) + '%';
      overlayEl.style.width = ((bFrac - aFrac) * 100) + '%';
      overlayEl.style.background = loopActive ? 'rgba(30,215,96,0.35)' : 'rgba(255,255,255,0.15)';
    } else {
      markerB.style.display = overlayEl.style.display = 'none';
    }
  }

  // =========================================================================
  // ACTIONS
  // =========================================================================
  function setPointA() {
    var p = getPosition(); if (p === null) return;
    pointA = p;
    if (pointB !== null && pointB <= pointA) pointB = null;
    activeSlot = null; saveToStorage(); updateProgressOverlay(); refresh();
  }
  function setPointB() {
    var p = getPosition(); if (p === null) return;
    pointB = p;
    if (pointA !== null && pointB <= pointA) { var t = pointA; pointA = pointB; pointB = t; }
    activeSlot = null; saveToStorage(); updateProgressOverlay(); refresh();
  }
  function toggleLoop() {
    if (pointA === null || pointB === null) return;
    loopActive = !loopActive;
    if (loopActive) loopCount = 0;
    updateProgressOverlay(); refresh();
  }
  function clearPoints() {
    pointA = null; pointB = null; loopActive = false; loopCount = 0; activeSlot = null;
    updateProgressOverlay(); saveToStorage(); refresh();
  }
  function saveSlot(i) {
    if (pointA === null || pointB === null) return;
    slots[i] = { a: pointA, b: pointB }; activeSlot = i;
    saveToStorage(); refresh();
  }
  function loadSlot(i) {
    if (!slots[i] || slots[i].a === null) return;
    pointA = slots[i].a; pointB = slots[i].b; activeSlot = i;
    loopActive = false; loopCount = 0;
    updateProgressOverlay(); saveToStorage(); refresh();
  }
  function deleteSlot(i) {
    slots[i] = { a: null, b: null };
    if (activeSlot === i) activeSlot = null;
    saveToStorage(); refresh();
  }
  function nudge(point, deltaMs) {
    if (point === 'a' && pointA !== null) { pointA = Math.max(0, pointA + deltaMs); }
    if (point === 'b' && pointB !== null) { pointB = Math.max(0, pointB + deltaMs); }
    updateProgressOverlay(); saveToStorage(); refresh();
  }
  function toggleCard() {
    cardOpen = !cardOpen;
    var card = document.getElementById('ab-loop-card');
    var btn = document.getElementById('ab-loop-pill-btn');
    if (card) card.classList.toggle('ab-open', cardOpen);
    if (btn) btn.classList.toggle('ab-active', cardOpen);
  }

  function fmt(ms) {
    if (ms === null) return '-:--';
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  // =========================================================================
  // STYLES
  // =========================================================================
  var STYLES = `
    /* ---- Player bar pill ---- */
    #ab-loop-pill {
      display: flex; align-items: center;
      gap: 4px; margin-left: 8px;
      position: relative; white-space: nowrap;
    }
    #ab-loop-pill button {
      all: unset; box-sizing: border-box;
      font-family: SpotifyMixUI, CircularSp-Arab, Helvetica Neue, helvetica, arial, sans-serif;
      font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(255,255,255,0.45); background: transparent;
      cursor: pointer; display: flex; align-items: center;
      justify-content: center; height: 24px; padding: 0 9px;
      transition: color 150ms cubic-bezier(0.3,0,0,1), background 150ms cubic-bezier(0.3,0,0,1);
      -webkit-user-select: none; user-select: none;
    }
    #ab-loop-pill button:hover  { color: #fff; background: rgba(255,255,255,0.07); }
    #ab-loop-pill button:active { background: rgba(255,255,255,0.12); }

    /* AB pill */
    #ab-loop-ab-group {
      display: flex; align-items: center;
      border-radius: 9999px; border: 1px solid rgba(255,255,255,0.1);
      overflow: hidden;
      transition: border-color 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-ab-group:hover { border-color: rgba(255,255,255,0.22); }
    #ab-loop-pill .ab-set { color: #1ed760 !important; }
    #ab-loop-pill .ab-divider { width:1px; height:14px; background:rgba(255,255,255,0.1); flex-shrink:0; }
    #ab-loop-pill .ab-clr { font-size:9px; color:rgba(255,255,255,0.25) !important; padding: 0 8px; }
    #ab-loop-pill .ab-clr:hover { color:rgba(255,255,255,0.75) !important; }

    /* Loop toggle */
    #ab-loop-toggle {
      border-radius: 9999px; border: 1px solid rgba(255,255,255,0.1);
      padding: 0 11px;
      transition: color 150ms cubic-bezier(0.3,0,0,1), border-color 150ms cubic-bezier(0.3,0,0,1), background 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-toggle:hover { border-color: rgba(255,255,255,0.25) !important; }
    #ab-loop-toggle.ab-active { color:#1ed760 !important; border-color:#1ed760 !important; background:rgba(30,215,96,0.08) !important; }
    #ab-loop-toggle.ab-active:hover { background:rgba(30,215,96,0.15) !important; }

    /* Timestamp label */
    #ab-loop-label {
      font-family: SpotifyMixUI, Helvetica Neue, sans-serif;
      font-size: 10px; font-weight: 500; letter-spacing: 0.02em;
      color: rgba(255,255,255,0.28); min-width: 68px; text-align: center;
      pointer-events: none;
      transition: color 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-label.ab-has-points { color: rgba(255,255,255,0.55); }
    #ab-loop-label.ab-active     { color: #1ed760; }

    /* Panel open button — dots style */
    #ab-loop-pill-btn {
      border-radius: 9999px; border: 1px solid rgba(255,255,255,0.1);
      padding: 0 8px; font-size: 16px; letter-spacing: 1px; line-height: 1;
      transition: color 150ms cubic-bezier(0.3,0,0,1), border-color 150ms cubic-bezier(0.3,0,0,1), background 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-pill-btn:hover { border-color: rgba(255,255,255,0.25) !important; }
    #ab-loop-pill-btn.ab-active { color:#1ed760 !important; border-color:#1ed760 !important; background:rgba(30,215,96,0.08) !important; }

    /* ---- Floating card ---- */
    #ab-loop-card {
      display: none;
      position: fixed;
      bottom: 90px;
      right: 16px;
      width: 300px;
      background: #282828;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.7);
      z-index: 99999;
      font-family: SpotifyMixUI, CircularSp-Arab, Helvetica Neue, helvetica, arial, sans-serif;
      overflow: hidden;
      user-select: none;
    }
    #ab-loop-card.ab-open { display: block; }

    /* Card header */
    #ab-loop-card .ab-card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    #ab-loop-card .ab-card-header-left {
      display: flex; align-items: center; gap: 8px;
    }
    #ab-loop-card .ab-card-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
      transition: background 200ms;
      flex-shrink: 0;
    }
    #ab-loop-card .ab-card-dot.ab-active { background: #1ed760; }
    #ab-loop-card .ab-card-title {
      font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
      color: #fff;
    }
    #ab-loop-card .ab-card-close {
      all: unset; cursor: pointer; box-sizing: border-box;
      width: 24px; height: 24px; border-radius: 6px;
      display: flex !important; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.35);
      background: rgba(255,255,255,0.05);
      transition: color 100ms, background 100ms;
      font-family: SpotifyMixUI, Helvetica Neue, sans-serif;
    }
    #ab-loop-card .ab-card-close:hover { color:#fff; background:rgba(255,255,255,0.12); }

    /* Card section */
    #ab-loop-card .ab-section {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    #ab-loop-card .ab-section:last-child { border-bottom: none; }
    #ab-loop-card .ab-section-title {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; color: rgba(255,255,255,0.3);
      margin-bottom: 12px;
    }

    /* Loop region rows — large time display */
    #ab-loop-card .ab-region-row {
      display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    }
    #ab-loop-card .ab-region-row:last-child { margin-bottom: 0; }
    #ab-loop-card .ab-region-badge {
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(30,215,96,0.15); border: 1px solid rgba(30,215,96,0.3);
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; color: #1ed760;
      flex-shrink: 0; transition: background 150ms, border-color 150ms;
    }
    #ab-loop-card .ab-region-badge.ab-unset {
      background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.3);
    }
    #ab-loop-card .ab-region-time {
      font-size: 19px; font-weight: 700; color: #fff;
      letter-spacing: -0.02em; flex: 1; line-height: 1;
    }
    #ab-loop-card .ab-region-time.ab-unset {
      font-size: 15px; color: rgba(255,255,255,0.2); font-weight: 500;
    }
    #ab-loop-card .ab-nudge-group { display: flex; gap: 4px; }
    #ab-loop-card .ab-nudge-btn {
      all: unset; cursor: pointer;
      font-size: 10px; font-weight: 700;
      color: rgba(255,255,255,0.35);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; padding: 4px 8px;
      transition: color 100ms, background 100ms, border-color 100ms;
    }
    #ab-loop-card .ab-nudge-btn:hover { color:#fff; background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.25); }

    /* Settings rows */
    #ab-loop-card .ab-setting-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    #ab-loop-card .ab-setting-row:last-child { margin-bottom: 0; }
    #ab-loop-card .ab-setting-name { font-size: 12px; color: rgba(255,255,255,0.7); }
    #ab-loop-card .ab-setting-hint { font-size: 10px; color: rgba(255,255,255,0.25); margin-top: 2px; }
    #ab-loop-card .ab-setting-ctrl { display: flex; gap: 3px; align-items: center; }
    #ab-loop-card .ab-chip {
      all: unset; cursor: pointer;
      font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      color: rgba(255,255,255,0.35);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9999px; padding: 3px 9px;
      transition: color 100ms, background 100ms, border-color 100ms;
    }
    #ab-loop-card .ab-chip:hover { color:#fff; border-color:rgba(255,255,255,0.25); background:rgba(255,255,255,0.06); }
    #ab-loop-card .ab-chip.ab-on { color:#1ed760; border-color:#1ed760; background:rgba(30,215,96,0.08); }
    #ab-loop-card .ab-chip.ab-on:hover { background:rgba(30,215,96,0.15); }

    /* Loop counter badge */
    #ab-loop-count-badge {
      font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.06);
      border-radius: 9999px; padding: 3px 12px;
    }

    /* Slots */
    #ab-loop-card .ab-slot-row {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 8px; border-radius: 6px; cursor: pointer;
      transition: background 100ms; margin: 0 -8px;
    }
    #ab-loop-card .ab-slot-row:hover { background: rgba(255,255,255,0.06); }
    #ab-loop-card .ab-slot-row.ab-slot-active { background: rgba(30,215,96,0.07); }
    #ab-loop-card .ab-slot-num {
      font-size: 11px; font-weight: 700;
      color: rgba(255,255,255,0.2); width: 14px; flex-shrink: 0;
    }
    #ab-loop-card .ab-slot-row.ab-slot-set .ab-slot-num { color: rgba(255,255,255,0.5); }
    #ab-loop-card .ab-slot-row.ab-slot-active .ab-slot-num { color: #1ed760; }
    #ab-loop-card .ab-slot-time { font-size: 11px; color: rgba(255,255,255,0.25); flex: 1; }
    #ab-loop-card .ab-slot-row.ab-slot-set .ab-slot-time { color: rgba(255,255,255,0.8); }
    #ab-loop-card .ab-slot-row.ab-slot-active .ab-slot-time { color: #1ed760; }
    #ab-loop-card .ab-slot-active-badge {
      font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
      color: rgba(30,215,96,0.7); background: rgba(30,215,96,0.1);
      border-radius: 4px; padding: 2px 6px;
      display: none;
    }
    #ab-loop-card .ab-slot-row.ab-slot-active .ab-slot-active-badge { display: block; }
    #ab-loop-card .ab-slot-actions { display:flex; gap:4px; opacity:0; transition:opacity 100ms; }
    #ab-loop-card .ab-slot-row:hover .ab-slot-actions { opacity:1; }
    #ab-loop-card .ab-slot-row.ab-slot-active .ab-slot-active-badge + .ab-slot-actions { display: none; }
    #ab-loop-card .ab-slot-btn {
      all: unset; cursor: pointer; font-size: 10px; font-weight: 700;
      color: rgba(255,255,255,0.35); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px; padding: 2px 7px;
      transition: color 100ms, background 100ms, border-color 100ms;
    }
    #ab-loop-card .ab-slot-btn:hover { color:#fff; background:rgba(255,255,255,0.08); }
    #ab-loop-card .ab-slot-del:hover { color:#e74c3c !important; border-color:#e74c3c !important; }

    /* Keyboard hint */
    #ab-loop-card .ab-kbd-hint {
      font-size: 9px; color: rgba(255,255,255,0.18);
      letter-spacing: 0.05em; text-align: center;
      padding: 9px 16px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    /* ---- Progress bar overlay ---- */
    #ab-loop-overlay-wrap { position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; }
    #ab-loop-overlay { position:absolute; top:0; height:100%; border-radius:2px; transition:background 200ms; display:none; }
    #ab-loop-marker-a, #ab-loop-marker-b {
      position:absolute; top:-2px; bottom:-2px; width:2px; border-radius:1px;
      transform:translateX(-50%); display:none; background:#1ed760;
    }
  `;

  function injectStyles() {
    if (document.getElementById('ab-loop-styles')) return;
    var s = document.createElement('style'); s.id = 'ab-loop-styles';
    s.textContent = STYLES; document.head.appendChild(s);
  }

  // =========================================================================
  // BUILD UI
  // =========================================================================
  var PILL_ID = 'ab-loop-pill';
  var bAEl, bBEl, bLoopEl, lblEl;

  function buildUI() {
    if (document.getElementById(PILL_ID)) return true;
    var repeat = document.querySelector('[data-testid="control-button-repeat"]');
    if (!repeat) return false;

    var rightGroup = repeat.parentElement;
    var row = rightGroup.parentElement;

    injectStyles();
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr auto 1fr';
    row.style.alignItems = 'center';

    // ---- Player bar pill ----
    var pill = document.createElement('div');
    pill.id = PILL_ID;

    // A/B/clr group
    var abGroup = document.createElement('div');
    abGroup.id = 'ab-loop-ab-group';

    bAEl = document.createElement('button'); bAEl.textContent = 'A'; bAEl.title = 'Set loop start (Alt+A)';
    bBEl = document.createElement('button'); bBEl.textContent = 'B'; bBEl.title = 'Set loop end (Alt+B)';
    var div1 = document.createElement('div'); div1.className = 'ab-divider';
    var bClr = document.createElement('button'); bClr.textContent = '✕'; bClr.className = 'ab-clr'; bClr.title = 'Clear (Alt+C)';
    abGroup.appendChild(bAEl); abGroup.appendChild(bBEl); abGroup.appendChild(div1); abGroup.appendChild(bClr);

    // Loop toggle
    bLoopEl = document.createElement('button');
    bLoopEl.id = 'ab-loop-toggle'; bLoopEl.textContent = 'loop'; bLoopEl.title = 'Toggle loop (Alt+L)';

    // Label
    lblEl = document.createElement('span'); lblEl.id = 'ab-loop-label';

    // Panel button
    var pillBtn = document.createElement('button');
    pillBtn.id = 'ab-loop-pill-btn'; pillBtn.textContent = '···'; pillBtn.title = 'Open A-B panel (Alt+P)';

    pill.appendChild(abGroup); pill.appendChild(bLoopEl);
    pill.appendChild(lblEl); pill.appendChild(pillBtn);
    rightGroup.appendChild(pill);

    // ---- Floating card ----
    var card = document.createElement('div'); card.id = 'ab-loop-card';

    // Header
    var hdr = document.createElement('div'); hdr.className = 'ab-card-header';
    var hdrLeft = document.createElement('div'); hdrLeft.className = 'ab-card-header-left';
    var dot = document.createElement('div'); dot.className = 'ab-card-dot'; dot.id = 'ab-card-dot';
    var title = document.createElement('div'); title.className = 'ab-card-title'; title.textContent = 'A-B Loop';
    hdrLeft.appendChild(dot); hdrLeft.appendChild(title);
    var closeBtn = document.createElement('button'); closeBtn.className = 'ab-card-close'; closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    closeBtn.title = 'Close (Alt+P)';
    closeBtn.onclick = function (e) { e.stopPropagation(); toggleCard(); };
    hdr.appendChild(hdrLeft); hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    // Loop region section
    var regionSec = document.createElement('div'); regionSec.className = 'ab-section';
    var regionTitle = document.createElement('div'); regionTitle.className = 'ab-section-title'; regionTitle.textContent = 'Loop Region';
    regionSec.appendChild(regionTitle);

    // Row A
    var rowA = document.createElement('div'); rowA.className = 'ab-region-row';
    var badgeA = document.createElement('div'); badgeA.className = 'ab-region-badge ab-unset'; badgeA.id = 'ab-card-badge-a'; badgeA.textContent = 'A';
    var timeA = document.createElement('div'); timeA.className = 'ab-region-time ab-unset'; timeA.id = 'ab-card-time-a';
    var nudgeGrpA = document.createElement('div'); nudgeGrpA.className = 'ab-nudge-group';
    var nA1 = document.createElement('button'); nA1.className = 'ab-nudge-btn'; nA1.textContent = '-1s';
    var nA2 = document.createElement('button'); nA2.className = 'ab-nudge-btn'; nA2.textContent = '+1s';
    nA1.onclick = function (e) { e.stopPropagation(); nudge('a', -1000); };
    nA2.onclick = function (e) { e.stopPropagation(); nudge('a', 1000); };
    nudgeGrpA.appendChild(nA1); nudgeGrpA.appendChild(nA2);
    rowA.appendChild(badgeA); rowA.appendChild(timeA); rowA.appendChild(nudgeGrpA);

    // Row B
    var rowB = document.createElement('div'); rowB.className = 'ab-region-row';
    var badgeB = document.createElement('div'); badgeB.className = 'ab-region-badge ab-unset'; badgeB.id = 'ab-card-badge-b'; badgeB.textContent = 'B';
    var timeB = document.createElement('div'); timeB.className = 'ab-region-time ab-unset'; timeB.id = 'ab-card-time-b';
    var nudgeGrpB = document.createElement('div'); nudgeGrpB.className = 'ab-nudge-group';
    var nB1 = document.createElement('button'); nB1.className = 'ab-nudge-btn'; nB1.textContent = '-1s';
    var nB2 = document.createElement('button'); nB2.className = 'ab-nudge-btn'; nB2.textContent = '+1s';
    nB1.onclick = function (e) { e.stopPropagation(); nudge('b', -1000); };
    nB2.onclick = function (e) { e.stopPropagation(); nudge('b', 1000); };
    nudgeGrpB.appendChild(nB1); nudgeGrpB.appendChild(nB2);
    rowB.appendChild(badgeB); rowB.appendChild(timeB); rowB.appendChild(nudgeGrpB);

    regionSec.appendChild(rowA); regionSec.appendChild(rowB);
    card.appendChild(regionSec);

    // Settings section
    var settingsSec = document.createElement('div'); settingsSec.className = 'ab-section';
    var settingsTitle = document.createElement('div'); settingsTitle.className = 'ab-section-title'; settingsTitle.textContent = 'Settings';

    function makeSettingRow(name, hint, ctrlId) {
      var row2 = document.createElement('div'); row2.className = 'ab-setting-row';
      var left = document.createElement('div');
      var nameEl = document.createElement('div'); nameEl.className = 'ab-setting-name'; nameEl.textContent = name;
      left.appendChild(nameEl);
      if (hint) { var hintEl = document.createElement('div'); hintEl.className = 'ab-setting-hint'; hintEl.textContent = hint; left.appendChild(hintEl); }
      var ctrl = document.createElement('div'); ctrl.className = 'ab-setting-ctrl'; ctrl.id = ctrlId;
      row2.appendChild(left); row2.appendChild(ctrl);
      return { row: row2, ctrl: ctrl };
    }

    // Speed row
    var speedRow = makeSettingRow('Speed', null, 'ab-speed-ctrl');
    SPEEDS.forEach(function (s) {
      var chip = document.createElement('button');
      chip.className = 'ab-chip'; chip.dataset.speed = s;
      chip.textContent = s === 1.0 ? '1x' : s + 'x';
      chip.onclick = function (e) { e.stopPropagation(); setSpeed(s); };
      speedRow.ctrl.appendChild(chip);
    });

    // Fade row
    var fadeRow = makeSettingRow('Fade on loop', '500ms crossfade at loop point', 'ab-fade-ctrl');
    var fadeChip = document.createElement('button');
    fadeChip.className = 'ab-chip'; fadeChip.id = 'ab-fade-chip';
    fadeChip.onclick = function (e) { e.stopPropagation(); fadeEnabled = !fadeEnabled; refresh(); };
    fadeRow.ctrl.appendChild(fadeChip);

    // Loop count row
    var countRow = makeSettingRow('Loop count', null, 'ab-count-ctrl');
    var badge = document.createElement('div'); badge.id = 'ab-loop-count-badge';
    countRow.ctrl.appendChild(badge);

    settingsSec.appendChild(settingsTitle);
    settingsSec.appendChild(speedRow.row);
    settingsSec.appendChild(fadeRow.row);
    settingsSec.appendChild(countRow.row);
    card.appendChild(settingsSec);

    // Saved slots section
    var slotsSec = document.createElement('div'); slotsSec.className = 'ab-section';
    var slotsTitle = document.createElement('div'); slotsTitle.className = 'ab-section-title'; slotsTitle.textContent = 'Saved Loops';
    slotsSec.appendChild(slotsTitle);

    for (var i = 0; i < 5; i++) {
      (function (idx) {
        var slotRow = document.createElement('div');
        slotRow.className = 'ab-slot-row'; slotRow.id = 'ab-card-slot-' + idx;
        var num = document.createElement('span'); num.className = 'ab-slot-num'; num.textContent = idx + 1;
        var time = document.createElement('span'); time.className = 'ab-slot-time'; time.id = 'ab-card-slot-time-' + idx;
        var activeBadge = document.createElement('span'); activeBadge.className = 'ab-slot-active-badge'; activeBadge.textContent = 'active';
        var actions = document.createElement('div'); actions.className = 'ab-slot-actions';
        var saveBtn = document.createElement('button'); saveBtn.className = 'ab-slot-btn'; saveBtn.textContent = 'save';
        var delBtn = document.createElement('button'); delBtn.className = 'ab-slot-btn ab-slot-del'; delBtn.textContent = 'del';
        saveBtn.onclick = function (e) { e.stopPropagation(); saveSlot(idx); };
        delBtn.onclick = function (e) { e.stopPropagation(); deleteSlot(idx); };
        actions.appendChild(saveBtn); actions.appendChild(delBtn);
        slotRow.appendChild(num); slotRow.appendChild(time); slotRow.appendChild(activeBadge); slotRow.appendChild(actions);
        slotRow.onclick = function () { loadSlot(idx); };
        slotsSec.appendChild(slotRow);
      })(i);
    }
    card.appendChild(slotsSec);

    // Keyboard hint
    var kbdHint = document.createElement('div'); kbdHint.className = 'ab-kbd-hint';
    kbdHint.textContent = 'Alt+A  Set A    Alt+B  Set B    Alt+L  Loop    Alt+C  Clear';
    card.appendChild(kbdHint);

    document.body.appendChild(card);

    // ---- Events ----
    bAEl.onclick = function (e) { e.stopPropagation(); setPointA(); };
    bBEl.onclick = function (e) { e.stopPropagation(); setPointB(); };
    bClr.onclick = function (e) { e.stopPropagation(); clearPoints(); };
    bLoopEl.onclick = function (e) { e.stopPropagation(); toggleLoop(); };
    pillBtn.onclick = function (e) { e.stopPropagation(); toggleCard(); };

    // Close card on outside click
    document.addEventListener('click', function (e) {
      if (cardOpen && !card.contains(e.target) && e.target !== pillBtn) {
        cardOpen = false;
        card.classList.remove('ab-open');
        pillBtn.classList.remove('ab-active');
      }
    });

    refresh();
    return true;
  }

  // =========================================================================
  // REFRESH
  // =========================================================================
  function refresh() {
    if (!bAEl) return;

    // Pill bar
    if (pointA !== null) bAEl.classList.add('ab-set'); else bAEl.classList.remove('ab-set');
    if (pointB !== null) bBEl.classList.add('ab-set'); else bBEl.classList.remove('ab-set');
    if (loopActive) bLoopEl.classList.add('ab-active'); else bLoopEl.classList.remove('ab-active');

    if (pointA !== null && pointB !== null) {
      lblEl.textContent = fmt(pointA) + ' - ' + fmt(pointB);
      lblEl.className = loopActive ? 'ab-active' : 'ab-has-points';
    } else if (pointA !== null) {
      lblEl.textContent = fmt(pointA) + ' - -:--';
      lblEl.className = 'ab-has-points';
    } else {
      lblEl.textContent = 'A - B';
      lblEl.className = '';
    }

    // Card header dot
    var dot = document.getElementById('ab-card-dot');
    if (dot) { if (loopActive) dot.classList.add('ab-active'); else dot.classList.remove('ab-active'); }

    // Card — A/B times + badges
    var tA = document.getElementById('ab-card-time-a');
    var tB = document.getElementById('ab-card-time-b');
    var bA2 = document.getElementById('ab-card-badge-a');
    var bB2 = document.getElementById('ab-card-badge-b');
    if (tA) { tA.textContent = pointA !== null ? fmt(pointA) : '-:--'; tA.className = 'ab-region-time' + (pointA === null ? ' ab-unset' : ''); }
    if (tB) { tB.textContent = pointB !== null ? fmt(pointB) : '-:--'; tB.className = 'ab-region-time' + (pointB === null ? ' ab-unset' : ''); }
    if (bA2) { bA2.className = 'ab-region-badge' + (pointA === null ? ' ab-unset' : ''); }
    if (bB2) { bB2.className = 'ab-region-badge' + (pointB === null ? ' ab-unset' : ''); }

    // Speed chips
    var speedCtrl = document.getElementById('ab-speed-ctrl');
    if (speedCtrl) {
      Array.from(speedCtrl.children).forEach(function (chip) {
        if (parseFloat(chip.dataset.speed) === speed) chip.classList.add('ab-on');
        else chip.classList.remove('ab-on');
      });
    }

    // Fade chip
    var fadeChip = document.getElementById('ab-fade-chip');
    if (fadeChip) { fadeChip.textContent = fadeEnabled ? 'on' : 'off'; if (fadeEnabled) fadeChip.classList.add('ab-on'); else fadeChip.classList.remove('ab-on'); }

    // Loop count badge
    var badge = document.getElementById('ab-loop-count-badge');
    if (badge) badge.textContent = loopActive ? 'x' + loopCount : '-';

    // Slot rows
    for (var i = 0; i < 5; i++) {
      var slotRow = document.getElementById('ab-card-slot-' + i);
      var slotTime = document.getElementById('ab-card-slot-time-' + i);
      if (!slotRow || !slotTime) continue;
      var slot = slots[i];
      if (slot && slot.a !== null) {
        slotTime.textContent = fmt(slot.a) + ' - ' + fmt(slot.b);
        slotRow.classList.add('ab-slot-set');
      } else {
        slotTime.textContent = 'empty';
        slotRow.classList.remove('ab-slot-set');
      }
      if (activeSlot === i) slotRow.classList.add('ab-slot-active');
      else slotRow.classList.remove('ab-slot-active');
    }
  }

  // =========================================================================
  // INJECTION + BOOT
  // =========================================================================
  function tryInject() {
    var repeat = document.querySelector('[data-testid="control-button-repeat"]');
    if (!repeat) return false;
    if (document.getElementById(PILL_ID)) { injectProgressOverlay(); return true; }
    var ok = buildUI();
    if (ok) {
      injectProgressOverlay();
      initKeyboardShortcuts();
      initTrackWatcher();
      startPolling();
    }
    return ok;
  }

  var domObserver = new MutationObserver(function () {
    if (document.querySelector('[data-testid="control-button-repeat"]')) tryInject();
  });

  function boot() {
    domObserver.observe(document.body, { childList: true, subtree: true });
    var t = setInterval(function () { if (tryInject()) clearInterval(t); }, 500);
    setTimeout(function () { clearInterval(t); }, 120000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) setTimeout(tryInject, 300);
    });
  }

  boot();
  setTimeout(tryInject, 1000);
  setTimeout(tryInject, 2000);
  setTimeout(tryInject, 4000);
})();