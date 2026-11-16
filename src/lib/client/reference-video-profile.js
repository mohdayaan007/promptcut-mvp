const RATIOS = [0.1, 0.3, 0.5, 0.7, 0.9];
const WIDTH = 640; const HEIGHT = 360;

function seek(video, time) { return new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error("Reference video could not be decoded locally")); video.currentTime = time; }); }

/** Reads local browser pixels only long enough to emit aggregate RGB moments. */
export async function analyseReferenceVideoLocally(file) {
  if (!file?.type?.startsWith("video/")) throw new Error("Choose a reference video");
  const video = document.createElement("video"); video.muted = true; video.preload = "auto";
  const url = URL.createObjectURL(file); video.src = url;
  try {
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("Reference video could not be decoded locally")); });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Reference video timing is invalid");
    const canvas = document.createElement("canvas"); canvas.width = WIDTH; canvas.height = HEIGHT;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("Local reference analysis is unavailable");
    let n = 0; const sum = [0, 0, 0]; const outer = [[0,0,0],[0,0,0],[0,0,0]];
    for (const ratio of RATIOS) { await seek(video, Math.min(video.duration - 0.001, video.duration * ratio)); context.drawImage(video, 0, 0, WIDTH, HEIGHT); const data = context.getImageData(0, 0, WIDTH, HEIGHT).data;
      for (let i=0;i<data.length;i+=4) { const x=[data[i],data[i+1],data[i+2]]; n++; for(let a=0;a<3;a++){sum[a]+=x[a];for(let b=0;b<3;b++)outer[a][b]+=x[a]*x[b];} }
    }
    const mean=sum.map((v)=>v/n); const covariance=outer.map((row,a)=>row.map((v,b)=>(v-sum[a]*sum[b]/n)/(n-1)));
    return { version: 1, sampleCount: n, mean, covariance, sampleRatios: RATIOS, width: WIDTH, height: HEIGHT, colorSpace: "srgb-rgb24-canvas" };
  } finally { URL.revokeObjectURL(url); video.remove(); }
}
