// svgParser.js
export const SVGPathParser = (function(){
  function createDefaultVertices(){
    const v=[], N=8;
    for(let i=0;i<N;i++){ const ang=i/N*Math.PI*2; v.push(new THREE.Vector2(Math.cos(ang),Math.sin(ang))); }
    return v;
  }
  function parsePathData(pathData){
    const vertices=[]; const commands = pathData.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi) || [];
    let currentX=0,currentY=0,startX=0,startY=0;
    function push(x,y){ vertices.push(new THREE.Vector2(x,y)); }
    commands.forEach(command=>{
      const type=command[0]; const rel=type===type.toLowerCase(); const T=type.toUpperCase();
      const nums=command.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n=>!isNaN(n));
      let i,x,y;
      switch(T){
        case 'M':
          if (nums.length>=2){
            x=rel?currentX+nums[0]:nums[0]; y=rel?currentY+nums[1]:nums[1];
            currentX=startX=x; currentY=startY=y; push(x,y);
            for(i=2;i+1<nums.length;i+=2){ const nx=rel?currentX+nums[i]:nums[i]; const ny=rel?currentY+nums[i+1]:nums[i+1]; currentX=nx; currentY=ny; push(nx,ny); }
          } break;
        case 'L':
          for(i=0;i+1<nums.length;i+=2){ x=rel?currentX+nums[i]:nums[i]; y=rel?currentY+nums[i+1]:nums[i+1]; currentX=x; currentY=y; push(x,y); }
          break;
        case 'H': nums.forEach(v=>{ const hx=rel?currentX+v:v; currentX=hx; push(hx,currentY); }); break;
        case 'V': nums.forEach(v=>{ const vy=rel?currentY+v:v; currentY=vy; push(currentX,vy); }); break;
        case 'C':
          for(i=0;i+5<nums.length;i+=6){
            const cp1x=rel?currentX+nums[i]:nums[i]; const cp1y=rel?currentY+nums[i+1]:nums[i+1];
            const cp2x=rel?currentX+nums[i+2]:nums[i+2]; const cp2y=rel?currentY+nums[i+3]:nums[i+3];
            x=rel?currentX+nums[i+4]:nums[i+4]; y=rel?currentY+nums[i+5]:nums[i+5];
            const N=8;
            for(let t=1;t<=N;t++){ const u=t/N, u1=1-u;
              const bx=u1*u1*u1*currentX + 3*u1*u1*u*cp1x + 3*u1*u*u*cp2x + u*u*u*x;
              const by=u1*u1*u1*currentY + 3*u1*u1*u*cp1y + 3*u1*u*u*cp2y + u*u*u*y;
              push(bx,by);
            }
            currentX=x; currentY=y;
          } break;
        case 'Q':
          for(i=0;i+3<nums.length;i+=4){
            const cpx=rel?currentX+nums[i]:nums[i]; const cpy=rel?currentY+nums[i+1]:nums[i+1];
            x=rel?currentX+nums[i+2]:nums[i+2]; y=rel?currentY+nums[i+3]:nums[i+3];
            const Nq=6;
            for(let tt=1;tt<=Nq;tt++){ const uu=tt/Nq, u1q=1-uu;
              const px=u1q*u1q*currentX + 2*u1q*uu*cpx + uu*uu*x;
              const py=u1q*u1q*currentY + 2*u1q*uu*cpy + uu*uu*y;
              push(px,py);
            }
            currentX=x; currentY=y;
          } break;
        case 'A':
          for(i=0;i+6<nums.length;i+=7){
            x=rel?currentX+nums[i+5]:nums[i+5]; y=rel?currentY+nums[i+6]:nums[i+6];
            const Na=8; for(let j=1;j<=Na;j++){ const tj=j/Na; push(currentX+tj*(x-currentX), currentY+tj*(y-currentY)); }
            currentX=x; currentY=y;
          } break;
        case 'Z':
          if (vertices.length){
            const last=vertices[vertices.length-1];
            const dx=last.x-startX, dy=last.y-startY;
            if (dx*dx+dy*dy>1e-6) push(startX,startY);
          }
          currentX=startX; currentY=startY; break;
      }
    });
    return vertices.length?vertices:createDefaultVertices();
  }
  function parseSVGPaths(block){
    if (!block || !block.trim()) return [{ vertices: createDefaultVertices(), pathIndex: 0, default: true }];
    const matches = block.match(/\[([^\]]*)\]/g);
    const parts = matches ? matches.map(p=>p.slice(1,-1)) : [block];
    const shapes=[];
    for (let i=0;i<parts.length;i++){
      const s=parts[i];
      try { shapes.push({ vertices: parsePathData(s.trim()), pathIndex:i, pathString:s }); }
      catch(e){ shapes.push({ vertices: createDefaultVertices(), pathIndex:i, fallback:true }); }
    }
    if (!shapes.length) shapes.push({ vertices: createDefaultVertices(), pathIndex: 0, default: true });
    return shapes;
  }
  return { parsePathData, createDefaultVertices, parseSVGPaths };
})();
