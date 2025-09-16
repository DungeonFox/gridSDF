// main.js
import { createScene } from './scene.js';
import { createParticles } from './particles.js';
import { buildUI } from './uiControls.js';
import { getRegistry, ensureInRegistry, resolveUID } from './utils.js';
import { ensureModule, modulesByUID, reloadAllUIDs, updateVisibility } from './moduleManager.js';

export function boot(){
  const { scene, camera, renderer } = createScene();
  window.__SG_SCENE = scene;

  // UI
  const controlsRoot = document.getElementById('controls');
  const ui = buildUI(controlsRoot);

  // Ensure an active UID exists
  const ACTIVE_UID = resolveUID();
  ensureInRegistry(ACTIVE_UID);

  // Modules load
  reloadAllUIDs(scene);
  ensureModule(ACTIVE_UID, scene, null, false);
  ui.renderUIDList(); ui.renderUIDSelect(); ui.applyVisibility();

  // Particles
  let { particles, meshes } = createParticles(scene, 100);
  const numEl = document.getElementById('numParticles');
  numEl.addEventListener('change', ()=>{
    // remove old meshes
    meshes.forEach(m=>scene.remove(m)); meshes.length=0; particles.length=0;
    const out = createParticles(scene, parseInt(numEl.value,10)||0);
    particles = out.particles; meshes = out.meshes;
  });

  // Animation
  const clock = new THREE.Clock();
  function animate(){
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // integrate particle motion
    for (let i=0;i<particles.length;i++){
      const p=particles[i];
      p.position.add(p.velocity.clone().multiplyScalar(dt));
      p.time += dt;
      if (p.position.x < -10 || p.position.x > 10) { p.velocity.x *= -1; p.position.x = Math.max(-10, Math.min(10, p.position.x)); }
      if (p.position.y < -10 || p.position.y > 10) { p.velocity.y *= -1; p.position.y = Math.max(-10, Math.min(10, p.position.y)); }
      if (p.position.z < -10 || p.position.z > 10) { p.velocity.z *= -1; p.position.z = Math.max(-10, Math.min(10, p.position.z)); }
      meshes[i].position.copy(p.position);
    }

    // apply to grids
    const affectAll = document.getElementById('chkAllAffect').checked;
    for (const id in modulesByUID){
      if (!Object.prototype.hasOwnProperty.call(modulesByUID, id)) continue; // safe check
      if (!affectAll && id !== ui.ACTIVE_UID) continue;
      modulesByUID[id].updateParticles(particles, dt);
    }

    renderer.render(scene, camera);
  }

  // Boot sequence continuity
  ui.refreshActiveUIFromModule();
  updateVisibility(ui.ACTIVE_UID, true, false);
  animate();
}
