(function () {
  'use strict';

  var pointA     = null;
  var pointB     = null;
  var loopActive = false;
  var pollInterval = null;

  // -- Progress bar fiber props ---------------------------------------------
  function getProgressProps() {
    var bar = document.querySelector('[data-testid="progress-bar"]');
    if (!bar) return null;
    var fkey = Object.keys(bar).find(function(k) {
      return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
    });
    if (!fkey) return null;
    var node = bar[fkey];
    var depth = 0;
    while (node) {
      depth++;
      var props = node.memoizedProps || node.pendingProps;
      if (props && depth === 4 && typeof props.onDragEnd === 'function' && typeof props.max === 'number') {
        return props;
      }
      if (depth > 10) break;
      node = node.return;
    }
    return null;
  }

  function getPosition() {
    var props = getProgressProps();
    if (props && typeof props.value === 'number') return props.value;
    var el = document.querySelector('[data-testid="playback-position"]');
    if (el) {
      var parts = el.textContent.trim().split(':');
      if (parts.length === 2) return (parseInt(parts[0],10)*60 + parseInt(parts[1],10)) * 1000;
    }
    return null;
  }

  function seekTo(ms) {
    var props = getProgressProps();
    if (!props) return;
    var fraction = Math.max(0, Math.min(1, ms / props.max));
    props.onDragEnd(fraction, { wasDraggedBeforeReleased: false });
  }

  // -- Polling --------------------------------------------------------------
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(function () {
      if (!loopActive || pointA === null || pointB === null) return;
      var pos = getPosition();
      if (pos !== null && pos >= pointB - 300) seekTo(pointA);
    }, 150);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  function fmt(ms) {
    if (ms === null) return '-:--';
    var s = Math.floor(ms / 1000);
    return Math.floor(s/60) + ':' + (s%60 < 10 ? '0' : '') + (s%60);
  }

  // -- Styles ---------------------------------------------------------------
  var STYLES = `
    #ab-loop-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
      white-space: nowrap;
    }
    #ab-loop-wrap .ab-group {
      display: flex;
      align-items: center;
      border-radius: 9999px;
      border: 1px solid rgba(255,255,255,0.1);
      overflow: hidden;
      transition: border-color 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-wrap .ab-group:hover {
      border-color: rgba(255,255,255,0.22);
    }
    #ab-loop-wrap button {
      all: unset;
      box-sizing: border-box;
      font-family: SpotifyMixUI, CircularSp-Arab, Helvetica Neue, helvetica, arial, sans-serif;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: rgba(255,255,255,0.45);
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      padding: 0 9px;
      transition: color 150ms cubic-bezier(0.3,0,0,1),
                  background 150ms cubic-bezier(0.3,0,0,1);
      -webkit-user-select: none;
      user-select: none;
    }
    #ab-loop-wrap button:hover {
      color: #fff;
      background: rgba(255,255,255,0.07);
    }
    #ab-loop-wrap button:active {
      background: rgba(255,255,255,0.12);
    }
    #ab-loop-wrap .ab-btn-a.ab-set { color: #1ed760; }
    #ab-loop-wrap .ab-btn-b.ab-set { color: #1ed760; }
    #ab-loop-wrap .ab-btn-a.ab-set:hover,
    #ab-loop-wrap .ab-btn-b.ab-set:hover { color: #1fdf64; }
    #ab-loop-wrap .ab-divider {
      width: 1px;
      height: 14px;
      background: rgba(255,255,255,0.1);
      flex-shrink: 0;
    }
    #ab-loop-wrap .ab-btn-clr {
      font-size: 9px;
      color: rgba(255,255,255,0.25);
      padding: 0 8px;
    }
    #ab-loop-wrap .ab-btn-clr:hover {
      color: rgba(255,255,255,0.75);
      background: rgba(255,255,255,0.07);
    }
    #ab-loop-wrap .ab-btn-loop {
      border-radius: 9999px;
      border: 1px solid rgba(255,255,255,0.1);
      padding: 0 11px;
      transition: color 150ms cubic-bezier(0.3,0,0,1),
                  border-color 150ms cubic-bezier(0.3,0,0,1),
                  background 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-wrap .ab-btn-loop:hover { border-color: rgba(255,255,255,0.25); }
    #ab-loop-wrap .ab-btn-loop.ab-active {
      color: #1ed760;
      border-color: #1ed760;
      background: rgba(30,215,96,0.08);
    }
    #ab-loop-wrap .ab-btn-loop.ab-active:hover {
      background: rgba(30,215,96,0.15);
      border-color: #1fdf64;
    }
    #ab-loop-wrap .ab-label {
      font-family: SpotifyMixUI, CircularSp-Arab, Helvetica Neue, helvetica, arial, sans-serif;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.02em;
      color: rgba(255,255,255,0.28);
      min-width: 68px;
      text-align: center;
      pointer-events: none;
      transition: color 150ms cubic-bezier(0.3,0,0,1);
    }
    #ab-loop-wrap .ab-label.ab-has-points { color: rgba(255,255,255,0.5); }
    #ab-loop-wrap .ab-label.ab-active     { color: #1ed760; }
  `;

  function injectStyles() {
    if (document.getElementById('ab-loop-styles')) return;
    var s = document.createElement('style');
    s.id = 'ab-loop-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  var WRAP_ID = 'ab-loop-wrap';

  function buildUI() {
    if (document.getElementById(WRAP_ID)) return true;

    var repeat = document.querySelector('[data-testid="control-button-repeat"]');
    if (!repeat) return false;

    var rightGroup    = repeat.parentElement;
    var row           = rightGroup.parentElement;
    var playerControls = row.parentElement; // data-testid="player-controls"

    injectStyles();

    // Switch row to grid so left/right columns stay equal width (1fr each)
    // regardless of what we add to either side — play button stays centered forever
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr auto 1fr';
    row.style.alignItems = 'center';

    var wrap = document.createElement('div');
    wrap.id = WRAP_ID;

    var group = document.createElement('div');
    group.className = 'ab-group';

    var bA = document.createElement('button');
    bA.className = 'ab-btn-a';
    bA.textContent = 'A';
    bA.title = 'Set loop start (A)';

    var bB = document.createElement('button');
    bB.className = 'ab-btn-b';
    bB.textContent = 'B';
    bB.title = 'Set loop end (B)';

    var divider = document.createElement('div');
    divider.className = 'ab-divider';

    var bClr = document.createElement('button');
    bClr.className = 'ab-btn-clr';
    bClr.textContent = '✕';
    bClr.title = 'Clear A/B points';

    group.appendChild(bA);
    group.appendChild(bB);
    group.appendChild(divider);
    group.appendChild(bClr);

    var bLoop = document.createElement('button');
    bLoop.className = 'ab-btn-loop';
    bLoop.textContent = 'loop';
    bLoop.title = 'Toggle A–B loop';

    var lbl = document.createElement('span');
    lbl.className = 'ab-label';

    wrap.appendChild(group);
    wrap.appendChild(bLoop);
    wrap.appendChild(lbl);

    // Append widget to the right group — grid keeps everything balanced
    rightGroup.appendChild(wrap);

    function refresh() {
      if (pointA !== null) bA.classList.add('ab-set'); else bA.classList.remove('ab-set');
      if (pointB !== null) bB.classList.add('ab-set'); else bB.classList.remove('ab-set');
      if (loopActive) bLoop.classList.add('ab-active'); else bLoop.classList.remove('ab-active');
      if (pointA !== null && pointB !== null) {
        lbl.textContent = fmt(pointA) + ' – ' + fmt(pointB);
        lbl.className = 'ab-label ' + (loopActive ? 'ab-active' : 'ab-has-points');
      } else if (pointA !== null) {
        lbl.textContent = fmt(pointA) + ' – -:--';
        lbl.className = 'ab-label ab-has-points';
      } else {
        lbl.textContent = 'A – B';
        lbl.className = 'ab-label';
      }
    }

    bA.onclick = function () {
      var p = getPosition();
      if (p === null) return;
      pointA = p;
      if (pointB !== null && pointB <= pointA) pointB = null;
      refresh();
    };
    bB.onclick = function () {
      var p = getPosition();
      if (p === null) return;
      pointB = p;
      if (pointA !== null && pointB <= pointA) {
        var tmp = pointA; pointA = pointB; pointB = tmp;
      }
      refresh();
    };
    bLoop.onclick = function () {
      if (pointA === null || pointB === null) {
        group.style.borderColor = 'rgba(255,255,255,0.45)';
        setTimeout(function () { group.style.borderColor = ''; }, 500);
        return;
      }
      loopActive = !loopActive;
      if (loopActive) startPolling(); else stopPolling();
      refresh();
    };
    bClr.onclick = function () {
      pointA = null; pointB = null; loopActive = false;
      stopPolling(); refresh();
    };

    refresh();
    return true;
  }

  function tryInject() {
    var repeat = document.querySelector('[data-testid="control-button-repeat"]');
    if (!repeat) return false;
    if (document.getElementById(WRAP_ID)) return true;
    return buildUI();
  }

  var observer = new MutationObserver(function () {
    if (document.querySelector('[data-testid="control-button-repeat"]')) {
      tryInject();
    }
  });

  function boot() {
    // Observe immediately — don't wait
    observer.observe(document.body, { childList: true, subtree: true });

    // Also poll every 500ms for up to 2 minutes
    var t = setInterval(function () {
      if (tryInject()) clearInterval(t);
    }, 500);
    setTimeout(function () { clearInterval(t); }, 120000);

    // Also retry on visibility change (user switches back to Spotify)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) setTimeout(tryInject, 500);
    });
  }

  // Start immediately, then again at 1s, 2s, 4s as fallback
  boot();
  setTimeout(tryInject, 1000);
  setTimeout(tryInject, 2000);
  setTimeout(tryInject, 4000);
})();