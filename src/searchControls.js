/**
 * Customer-app search control state (pure logic).
 *
 * PRE-R1 STOP UX fix: pressing STOP at the continuation state must restore
 * the primary controls (RUN SEARCH visible, CONTINUE DEEP SEARCH hidden,
 * STOP hidden) without a browser refresh, preserving already-found results.
 */
export const SEARCH_PHASES = {
  IDLE: 'idle', // no search running — RUN SEARCH is the primary CTA
  RUNNING: 'running', // PASS1 or deep sweep in progress — STOP visible
  CONTINUATION: 'continuation', // 60-cap reached, more may exist — CONTINUE + STOP offered
};

/** Maps a phase to button visibility. STOP at continuation → idle (fix). */
export function controlsFor(phase) {
  switch (phase) {
    case 'running':
      return { showRun: false, showStop: true, showDeep: false };
    case 'continuation':
      return { showRun: false, showStop: true, showDeep: true };
    case 'idle':
    default:
      return { showRun: true, showStop: false, showDeep: false };
  }
}

/**
 * Pure STOP transition: continuation/running → idle.
 * Results are intentionally preserved (rows are untouched by this transition).
 */
export function stopTransition(phase) {
  return { nextPhase: 'idle', controls: controlsFor('idle') };
}

/** Normal completion transition: any active phase → idle. */
export function completeTransition() {
  return { nextPhase: 'idle', controls: controlsFor('idle') };
}

/** Applying the controls to the DOM (kept separate so the pure module stays DOM-free). */
export function applyControlsToElements(controls, elements) {
  const { runBtn, stopBtn, deepBtn } = elements;
  if (runBtn) runBtn.classList.toggle('hidden', !controls.showRun);
  if (stopBtn) stopBtn.classList.toggle('hidden', !controls.showStop);
  if (deepBtn) deepBtn.classList.toggle('hidden', !controls.showDeep);
}
