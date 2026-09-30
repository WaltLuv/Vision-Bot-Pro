// The preview's camera. A published page cannot open the phone's camera, so a
// drawn sample scene stands in for it, labelled as one -- or a photo the owner
// picks, which is then exactly what "Send photo" and "Ask about this" send.

function drawScene(ctx: CanvasRenderingContext2D, t: number) {
  const g = ctx.createLinearGradient(0, 0, 0, 960);
  g.addColorStop(0, '#2b3440'); g.addColorStop(1, '#171c23');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 720, 960);
  ctx.strokeStyle = '#46536a'; ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {ctx.beginPath(); ctx.moveTo(0, 120 + i * 70); ctx.lineTo(720, 90 + i * 70); ctx.stroke();}
  // A handrail on two stainless brackets, the bolts drawn in.
  ctx.fillStyle = '#8b6b3a'; ctx.fillRect(110, 400, 500, 70);
  ctx.fillStyle = '#b9c4d4'; ctx.fillRect(180, 470, 44, 150); ctx.fillRect(496, 470, 44, 150);
  ctx.fillStyle = '#e4e9f1';
  for (const x of [202, 518]) for (const y of [540, 590]) {ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();}
  ctx.fillStyle = '#6ea8ff'; ctx.beginPath(); ctx.arc(360 + Math.sin(t / 30) * 120, 435, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 880, 720, 80);
  ctx.fillStyle = '#e9eef6'; ctx.font = '600 30px system-ui, sans-serif';
  ctx.fillText('Sample scene: not a real camera', 24, 930);
}

/** A still of the sample scene, for the sample task's photo evidence. */
export function sceneBlob(): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = 960;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  drawScene(ctx, 0);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

export function installSampleCamera() {
  const canvas = document.createElement('canvas');
  canvas.width = 720; canvas.height = 960;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') return null;
  let photo: ImageBitmap | null = null;
  let t = 0;
  const draw = () => {
    t += 1;
    if (!photo) {drawScene(ctx, t); return;}
    // The picked photo fills the frame, as the viewfinder shows a real one.
    const scale = Math.max(720 / photo.width, 960 / photo.height);
    const w = photo.width * scale, h = photo.height * scale;
    ctx.drawImage(photo, (720 - w) / 2, (960 - h) / 2, w, h);
  };
  draw();
  setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => stream.clone(),
      enumerateDevices: async () => [{kind: 'videoinput', deviceId: 'back'}, {kind: 'videoinput', deviceId: 'front'}],
    },
  });
  return {
    async usePhoto(file: Blob) {photo = await createImageBitmap(file);},
  };
}
