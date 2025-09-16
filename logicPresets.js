// logicPresets.js
export function presetCode(name){
  switch(name){
    case 'Attract': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; var toC=ctx.center.clone().sub(ctx.p.position); var len=toC.length()||1e-6; ctx.p.velocity.addScaledVector(toC,0.2*ctx.dt*k/len); if(ctx.inside) ctx.p.velocity.multiplyScalar(0.995); }";
    case 'Repel': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; var fromC=ctx.p.position.clone().sub(ctx.center); var len=fromC.length()||1e-6; ctx.p.velocity.addScaledVector(fromC,0.25*ctx.dt*k/len); if(ctx.inside) ctx.p.velocity.multiplyScalar(0.99); }";
    case 'Vortex': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; var r=ctx.p.position.clone().sub(ctx.center); var axis=new THREE.Vector3(0,1,0); var tang=new THREE.Vector3().crossVectors(axis,r).normalize(); ctx.p.velocity.addScaledVector(tang,0.8*ctx.dt*k); if(ctx.grad) ctx.p.velocity.addScaledVector(ctx.grad,-0.08*ctx.dt*k); }";
    case 'Swirl': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; var r=ctx.p.position.clone().sub(ctx.center); var tang=new THREE.Vector3().crossVectors(r.clone().normalize(),new THREE.Vector3(0,0,1)).normalize(); var radial=r.clone().normalize(); var radialGain=ctx.sd>0?-0.2:0.2; ctx.p.velocity.addScaledVector(tang,0.6*ctx.dt*k); ctx.p.velocity.addScaledVector(radial,radialGain*ctx.dt*k); }";
    case 'BoundarySpring': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; if(!ctx.grad) return; var n=ctx.grad.clone().normalize(); var target=-ctx.sd; ctx.p.velocity.addScaledVector(n,1.2*target*ctx.dt*k); ctx.p.velocity.multiplyScalar(0.995); }";
    case 'Turbulence': return "function applyForce(ctx){ var k=(typeof ctx.forceScale==='number')?ctx.forceScale:1; var jitter=new THREE.Vector3(Math.random()-0.5,Math.random()-0.5,Math.random()-0.5); ctx.p.velocity.addScaledVector(jitter,0.3*ctx.dt*k); if(ctx.inside&&ctx.grad) ctx.p.velocity.addScaledVector(ctx.grad.clone().normalize(),-0.05*ctx.dt*k); }";
    default: return "function applyForce(ctx){ }";
  }
}
