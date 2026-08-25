import { describe, expect, it } from 'vitest';
import {
  applyControlsToElements,
  completeTransition,
  controlsFor,
  SEARCH_PHASES,
  stopTransition,
} from '../src/searchControls.js';

function fakeElement() {
  const classList = {
    _set: new Set(),
    add(cls) { this._set.add(cls); },
    remove(cls) { this._set.delete(cls); },
    toggle(cls, force) {
      if (force === undefined) {
        if (this._set.has(cls)) { this._set.delete(cls); return false; }
        this._set.add(cls); return true;
      }
      if (force) this._set.add(cls);
      else this._set.delete(cls);
      return force;
    },
    contains(cls) { return this._set.has(cls); },
  };
  return { classList };
}

describe('searchControls — phase → button visibility', () => {
  it('idle shows RUN SEARCH only', () => {
    const c = controlsFor(SEARCH_PHASES.IDLE);
    expect(c).toEqual({ showRun: true, showStop: false, showDeep: false });
  });

  it('running shows STOP only', () => {
    const c = controlsFor(SEARCH_PHASES.RUNNING);
    expect(c).toEqual({ showRun: false, showStop: true, showDeep: false });
  });

  it('continuation (60-cap) shows CONTINUE DEEP SEARCH + STOP', () => {
    const c = controlsFor(SEARCH_PHASES.CONTINUATION);
    expect(c).toEqual({ showRun: false, showStop: true, showDeep: true });
  });
});

describe('searchControls — STOP transition (PRE-R1 fix)', () => {
  it('STOP at continuation restores RUN SEARCH without refresh', () => {
    const { nextPhase, controls } = stopTransition(SEARCH_PHASES.CONTINUATION);
    expect(nextPhase).toBe('idle');
    expect(controls.showRun).toBe(true);
    expect(controls.showStop).toBe(false);
    expect(controls.showDeep).toBe(false);
  });

  it('STOP at running restores RUN SEARCH', () => {
    const { nextPhase, controls } = stopTransition(SEARCH_PHASES.RUNNING);
    expect(nextPhase).toBe('idle');
    expect(controls.showRun).toBe(true);
  });

  it('normal completion returns to idle', () => {
    const { controls } = completeTransition();
    expect(controls).toEqual({ showRun: true, showStop: false, showDeep: false });
  });
});

describe('searchControls — DOM application', () => {
  it('applies idle controls to the three buttons', () => {
    const runBtn = fakeElement();
    const stopBtn = fakeElement();
    const deepBtn = fakeElement();
    applyControlsToElements(controlsFor(SEARCH_PHASES.IDLE), { runBtn, stopBtn, deepBtn });
    expect(runBtn.classList.contains('hidden')).toBe(false);
    expect(stopBtn.classList.contains('hidden')).toBe(true);
    expect(deepBtn.classList.contains('hidden')).toBe(true);
  });

  it('applies continuation controls', () => {
    const runBtn = fakeElement();
    const stopBtn = fakeElement();
    const deepBtn = fakeElement();
    applyControlsToElements(controlsFor(SEARCH_PHASES.CONTINUATION), { runBtn, stopBtn, deepBtn });
    expect(runBtn.classList.contains('hidden')).toBe(true);
    expect(stopBtn.classList.contains('hidden')).toBe(false);
    expect(deepBtn.classList.contains('hidden')).toBe(false);
  });

  it('tolerates missing elements (null-safe)', () => {
    expect(() => applyControlsToElements(controlsFor(SEARCH_PHASES.IDLE), { runBtn: null, stopBtn: null, deepBtn: null })).not.toThrow();
  });
});
