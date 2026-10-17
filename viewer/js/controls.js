import * as THREE from "three";

// Camera control modelled on TaleSpire's: the camera orbits a focus point that you move
// around the board.
//   WASD          move the focus point (relative to where the camera faces)
//   Q / E         rotate around it
//   R / F         move it up / down (to get between floors)
//   right-drag    rotate and tilt (Ctrl- or Option-drag on a trackpad)
//   middle-drag   pan
//   wheel / pinch zoom; horizontal two-finger swipe rotates
// Left-drag is left to the active tool, unless leftDrag is set to "rotate".
export class TaleSpireControls {
  constructor(dom) {
    this.dom = dom;
    this.target = new THREE.Vector3();
    this.yaw = Math.PI / 4;
    this.pitch = 0.95;
    this.distance = 40;
    this.minPitch = 0.12;
    this.maxPitch = 1.553; // a hair under straight down; lookAt degenerates at exactly 90 deg
    this.minDistance = 2;
    this.maxDistance = 3000;
    this.leftDrag = null; // "rotate" | null
    this.enabled = true;  // off while the first-person view drives the camera
    this.keys = new Set();
    this.onChange = null;

    this._drag = null;
    dom.addEventListener("pointerdown", (e) => this._down(e));
    dom.addEventListener("pointermove", (e) => this._move(e));
    dom.addEventListener("pointerup", (e) => this._up(e));
    dom.addEventListener("pointercancel", (e) => this._up(e));
    dom.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  get dragging() {
    return this._drag !== null;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  right(out = new THREE.Vector3()) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  setTopDown(on) {
    this.pitch = on ? this.maxPitch : 0.95;
    this._changed();
  }

  // Frames a THREE.Box3 from above at the current yaw.
  fit(box, { topDown = false } = {}) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.target.copy(center);
    this.target.y = box.min.y + Math.min(size.y, 2);
    this.distance = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 1.1, 8, this.maxDistance);
    this.pitch = topDown ? this.maxPitch : 0.95;
    this._changed();
  }

  update(dt, camera) {
    const k = this.keys;
    const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? 3 : 1;
    const speed = Math.max(this.distance, 10) * 0.7 * fast * dt;
    const move = new THREE.Vector3();
    if (k.has("KeyW")) move.add(this.forward());
    if (k.has("KeyS")) move.sub(this.forward());
    if (k.has("KeyD")) move.add(this.right());
    if (k.has("KeyA")) move.sub(this.right());
    if (move.lengthSq() > 0) {
      this.target.addScaledVector(move.normalize(), speed);
      this._changed();
    }
    if (k.has("KeyR")) { this.target.y += 6 * fast * dt; this._changed(); }
    if (k.has("KeyF")) { this.target.y -= 6 * fast * dt; this._changed(); }
    if (k.has("KeyQ")) { this.yaw += 1.6 * dt; this._changed(); }
    if (k.has("KeyE")) { this.yaw -= 1.6 * dt; this._changed(); }

    const c = Math.cos(this.pitch);
    camera.position.set(
      this.target.x + c * Math.sin(this.yaw) * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + c * Math.cos(this.yaw) * this.distance
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    if (camera.isOrthographicCamera) {
      const aspect = this.dom.clientWidth / Math.max(this.dom.clientHeight, 1);
      const half = this.distance * 0.45;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
    }
  }

  _changed() {
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.minPitch, this.maxPitch);
    this.distance = THREE.MathUtils.clamp(this.distance, this.minDistance, this.maxDistance);
    this.onChange?.();
  }

  _down(e) {
    if (!this.enabled) return;
    let mode = null;
    if (e.button === 2 || (e.button === 0 && (e.ctrlKey || e.altKey))) mode = "rotate";
    else if (e.button === 1) mode = "pan";
    else if (e.button === 0 && this.leftDrag === "rotate") mode = e.shiftKey ? "pan" : "rotate";
    if (!mode) return;
    e.preventDefault();
    this._drag = { mode, x: e.clientX, y: e.clientY, id: e.pointerId };
    this.dom.setPointerCapture(e.pointerId);
  }

  _move(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.mode === "rotate") {
      this.yaw -= dx * 0.006;
      this.pitch += dy * 0.006;
    } else {
      const scale = this.distance * 0.0016;
      this.target.addScaledVector(this.right(), -dx * scale);
      this.target.addScaledVector(this.forward(), dy * scale);
    }
    this._changed();
  }

  _up(e) {
    if (this._drag && e.pointerId === this._drag.id) {
      this.dom.releasePointerCapture(e.pointerId);
      this._drag = null;
    }
  }

  _wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.yaw += e.deltaX * 0.004; // horizontal two-finger swipe
    } else {
      // Pinch arrives as ctrl+wheel with small deltas; scale it up to feel the same.
      const factor = e.ctrlKey ? 0.012 : 0.0015;
      this.distance *= Math.exp(e.deltaY * factor);
    }
    this._changed();
  }
}

export function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
