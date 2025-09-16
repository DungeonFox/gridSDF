// particles.js
import { createRandomQuaternion } from './utils.js';

export function createParticles(scene, n){
  const particles=[]; const meshes=[];
  const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const geo = new THREE.SphereGeometry(0.1, 8, 8);
  for(let i=0;i<n;i++){
    const position=new THREE.Vector3(Math.random()*10-5, Math.random()*10-5, Math.random()*10-5);
    const velocity=new THREE.Vector3((Math.random()-0.5)*0.1, (Math.random()-0.5)*0.1, (Math.random()-0.5)*0.1);
    const orientation=createRandomQuaternion();
    particles.push({ position, velocity, orientation, density:1, time:0, id:i });
    const mesh=new THREE.Mesh(geo, mat); mesh.position.copy(position); scene.add(mesh); meshes.push(mesh);
  }
  return { particles, meshes };
}
